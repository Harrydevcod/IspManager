import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import {
  isSealed,
  readSecret,
  readSecretsLost,
  refreshSecretsLost,
  resetSealingCache,
  sealPendingSecrets,
  SECRETS_LOST_KEY,
  setSealingBackend,
  writeSecret
} from './secrets';

/**
 * Os testes correm sem Electron, por isso o caminho por omissão aqui é o do
 * texto simples — que é exatamente o que se quer garantir que continua a
 * funcionar (Linux sem keyring, arranque headless). O caminho selado força-se
 * com um `safeStorage` de mentira.
 */
function memoryDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function raw(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

/** Cifra de brincar, com "conta" para simular outra máquina. */
function fakeSafeStorage(account = 'A') {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`${account}:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf8');
      if (!text.startsWith(`${account}:`)) throw new Error('selado noutra conta');
      return text.slice(account.length + 1);
    }
  };
}

function withSealing(account: string, run: () => void) {
  setSealingBackend(fakeSafeStorage(account));
  try {
    run();
  } finally {
    setSealingBackend(null);
  }
}

// Sem Electron a deteção automática já daria texto simples, mas dizê-lo aqui
// evita que um dia um teste vizinho deixe a costura suja.
beforeEach(() => {
  setSealingBackend(null);
});

afterEach(() => {
  resetSealingCache();
});

describe('sem cifra disponível', () => {
  test('grava e lê em texto simples, como antes', () => {
    const db = memoryDb();
    writeSecret(db, 'routerosPassword', 'senha-do-router');
    expect(raw(db, 'routerosPassword')).toBe('senha-do-router');
    expect(readSecret(db, 'routerosPassword')).toBe('senha-do-router');
    db.close();
  });

  test('um valor selado não abre — e não é apagado', () => {
    const db = memoryDb();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run('ultraMsgToken', 'enc:v1:QTp0b2tlbg==');

    expect(readSecret(db, 'ultraMsgToken')).toBe('');
    expect(sealPendingSecrets(db)).toEqual([]);
    // Apagá-lo seria destruir a credencial de quem abriu a aplicação no sítio
    // errado, ou num Linux sem keyring nesse arranque.
    expect(raw(db, 'ultraMsgToken')).toBe('enc:v1:QTp0b2tlbg==');
    db.close();
  });
});

describe('com cifra disponível', () => {
  test('o que se grava fica ilegível no ficheiro e legível pela aplicação', () => {
    const db = memoryDb();
    withSealing('A', () => {
      writeSecret(db, 'routerosPassword', 'senha-do-router');
      expect(isSealed(raw(db, 'routerosPassword'))).toBe(true);
      expect(raw(db, 'routerosPassword')).not.toContain('senha-do-router');
      expect(readSecret(db, 'routerosPassword')).toBe('senha-do-router');
    });
    db.close();
  });

  test('sela o que já lá estava em claro, e a segunda passagem não mexe', () => {
    const db = memoryDb();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('ultraMsgToken', 'token-antigo');

    withSealing('A', () => {
      expect(sealPendingSecrets(db)).toEqual([]);
      const first = raw(db, 'ultraMsgToken');
      expect(isSealed(first)).toBe(true);
      expect(readSecret(db, 'ultraMsgToken')).toBe('token-antigo');

      expect(sealPendingSecrets(db)).toEqual([]);
      expect(raw(db, 'ultraMsgToken')).toBe(first);
    });
    db.close();
  });

  test('base vinda de outra conta: avisa, preserva os bytes, e não toca no resto', () => {
    const db = memoryDb();
    withSealing('OUTRA', () => {
      writeSecret(db, 'routerosPassword', 'senha-da-outra-maquina');
    });
    const seladoLa = raw(db, 'routerosPassword');
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('companyName', 'SKYNET');

    withSealing('A', () => {
      const lost = sealPendingSecrets(db);
      expect(lost).toEqual(['Senha do router de gestão']);
      // Não se apaga. Quem restaurou um backup no sítio errado leva o ficheiro
      // de volta à máquina original e encontra lá a credencial; apagá-la aqui
      // tornava a viagem de ida sem volta. Quem lê a credencial continua a ver
      // vazio — `readSecret` já devolve '' para o que não abre — e é isso que
      // mantém as Definições honestas sem destruir nada.
      expect(raw(db, 'routerosPassword')).toBe(seladoLa);
      expect(readSecret(db, 'routerosPassword')).toBe('');
      expect(readSecretsLost(db)).toEqual(['Senha do router de gestão']);

      // Segunda passagem: mesmo aviso, mesmos bytes. Nada se acumula.
      expect(sealPendingSecrets(db)).toEqual(['Senha do router de gestão']);
      expect(raw(db, 'routerosPassword')).toBe(seladoLa);
    });

    expect(raw(db, 'companyName')).toBe('SKYNET');
    db.close();
  });

  test('reescrever a credencial na máquina nova cala o aviso', () => {
    const db = memoryDb();
    withSealing('OUTRA', () => {
      writeSecret(db, 'routerosPassword', 'senha-da-outra-maquina');
    });

    withSealing('A', () => {
      expect(sealPendingSecrets(db)).toEqual(['Senha do router de gestão']);

      writeSecret(db, 'routerosPassword', 'senha-desta-maquina');
      expect(refreshSecretsLost(db)).toEqual([]);
      expect(readSecretsLost(db)).toEqual([]);
      expect(readSecret(db, 'routerosPassword')).toBe('senha-desta-maquina');
    });
    db.close();
  });

  test('vazio não conta como perdido', () => {
    const db = memoryDb();
    withSealing('A', () => {
      writeSecret(db, 'ultraMsgToken', '');
      expect(sealPendingSecrets(db)).toEqual([]);
      expect(raw(db, SECRETS_LOST_KEY)).toBe('[]');
    });
    db.close();
  });
});
