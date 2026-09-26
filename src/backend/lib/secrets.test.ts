import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { fakeMachine, memoryVault } from './credentials.testing';
import {
  canStoreSecrets,
  readSecret,
  readSecretsLost,
  refreshSecretsLost,
  SECRET_KEYS,
  SECRETS_LOST_KEY,
  setCredentialVault,
  writeSecret
} from './secrets';
import { openVault } from './vault';

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

// O setup global deixa um cofre pronto; cada teste que o troque repõe-no.
afterEach(() => {
  setCredentialVault(memoryVault());
});

describe('com o cofre pronto', () => {
  test('o que se grava fica ilegível no ficheiro e legível pela aplicação', () => {
    const db = memoryDb();
    writeSecret(db, 'routerosPassword', 'senha-do-router');
    expect(raw(db, 'routerosPassword').startsWith('enc:v2:')).toBe(true);
    expect(raw(db, 'routerosPassword')).not.toContain('senha-do-router');
    expect(readSecret(db, 'routerosPassword')).toBe('senha-do-router');
  });

  test('preserva os bytes: espaços nas pontas fazem parte da senha', () => {
    const db = memoryDb();
    writeSecret(db, 'ultraMsgToken', '  tok en  ');
    expect(readSecret(db, 'ultraMsgToken')).toBe('  tok en  ');
  });

  test('vazio apaga, e não precisa do cofre', () => {
    const db = memoryDb();
    writeSecret(db, 'ultraMsgToken', 'x');
    setCredentialVault(null);
    writeSecret(db, 'ultraMsgToken', '');
    expect(raw(db, 'ultraMsgToken')).toBe('');
  });

  test('a chave das sessões já não é uma credencial portátil', () => {
    expect(SECRET_KEYS).not.toContain('auth_secret');
  });
});

describe('com o cofre trancado ou ausente', () => {
  test('gravar recusa — nunca cai para texto simples', () => {
    const db = memoryDb();
    setCredentialVault(openVault(db, fakeMachine('A')));
    const locked = openVault(new Database(db.serialize()), fakeMachine('B'));
    expect(locked.status()).toBe('locked');
    setCredentialVault(locked);
    expect(canStoreSecrets()).toBe(false);
    expect(() => writeSecret(db, 'routerosPassword', 'nova')).toThrow('VAULT_LOCKED');

    setCredentialVault(null);
    expect(canStoreSecrets()).toBe(false);
    expect(() => writeSecret(db, 'routerosPassword', 'nova')).toThrow('VAULT_UNAVAILABLE');
    expect(raw(db, 'routerosPassword')).toBe('');
  });

  test('ler devolve vazio e não apaga nada; o aviso diz o que não abre', () => {
    const db = memoryDb();
    writeSecret(db, 'routerosPassword', 'senha');
    const stored = raw(db, 'routerosPassword');
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('companyName', 'SKYNET')").run();

    setCredentialVault(null);
    expect(readSecret(db, 'routerosPassword')).toBe('');
    expect(refreshSecretsLost(db)).toEqual(['Senha do router de gestão']);
    expect(readSecretsLost(db)).toEqual(['Senha do router de gestão']);
    expect(raw(db, 'routerosPassword')).toBe(stored);
    expect(raw(db, 'companyName')).toBe('SKYNET');
  });
});

describe('aviso de credenciais perdidas', () => {
  test('valores legados por migrar contam como indisponíveis', () => {
    const db = memoryDb();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ultraMsgToken', 'token-em-claro')").run();
    expect(readSecret(db, 'ultraMsgToken')).toBe('');
    expect(refreshSecretsLost(db)).toEqual(['Token UltraMsg']);
  });

  test('reescrever a credencial cala o aviso; vazio não conta como perdido', () => {
    const db = memoryDb();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ultraMsgToken', 'enc:v1:QTp0b2tlbg==')").run();
    expect(refreshSecretsLost(db)).toEqual(['Token UltraMsg']);
    writeSecret(db, 'ultraMsgToken', 'novo');
    expect(refreshSecretsLost(db)).toEqual([]);
    expect(raw(db, SECRETS_LOST_KEY)).toBe('[]');
  });
});
