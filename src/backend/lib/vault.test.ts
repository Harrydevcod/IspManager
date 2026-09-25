import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { createLocalProtection, type LocalProtection } from './local-protection';
import { openVault } from './vault';

function memoryDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

/** DPAPI de brincar: o que uma "máquina" sela só essa máquina abre. */
function machine(name: string): LocalProtection {
  return createLocalProtection({
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`${name}:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf8');
      if (!text.startsWith(`${name}:`)) throw new Error('outra máquina');
      return text.slice(name.length + 1);
    }
  });
}

const noProtection = createLocalProtection(null);
const CTX = 'services.pppoe_password';

function vaultRow(db: Database.Database) {
  return db.prepare('SELECT * FROM credential_vault').get() as Record<string, unknown> | undefined;
}

/** Copiar o ficheiro para outra máquina = serializar e reabrir. */
function copyDb(db: Database.Database) {
  return new Database(db.serialize());
}

describe('openVault', () => {
  test('sem proteção local nunca cria o cofre nem escreve na base (D3)', () => {
    const db = memoryDb();
    const vault = openVault(db, noProtection);
    expect(vault.status()).toBe('absent');
    expect(vaultRow(db)).toBeUndefined();
    expect(() => vault.encrypt(CTX, 'x')).toThrow('VAULT_UNAVAILABLE');
  });

  test('cria o cofre com entrega da chave de recuperação pendente', () => {
    const db = memoryDb();
    const vault = openVault(db, machine('A'));
    expect(vault.status()).toBe('recovery_pending');
    const stored = vault.encrypt(CTX, 'senha-1');
    expect(stored.startsWith('enc:v2:')).toBe(true);
    expect(vault.decrypt(CTX, stored)).toBe('senha-1');

    const key = vault.pendingRecoveryKey();
    expect(key).toMatch(/^ISPM(-[A-Z2-7]{4}){13}$/);
    const row = vaultRow(db)!;
    for (const value of Object.values(row)) expect(String(value)).not.toContain(key.slice(5, 20));
  });

  test('reabrir na mesma máquina devolve a mesma chave de dados', () => {
    const db = memoryDb();
    const stored = openVault(db, machine('A')).encrypt(CTX, 'senha-1');
    const again = openVault(db, machine('A'));
    expect(again.status()).toBe('recovery_pending');
    expect(again.decrypt(CTX, stored)).toBe('senha-1');
  });

  test('confirmar exige a chave exata e depois esquece a entrega', () => {
    const db = memoryDb();
    const vault = openVault(db, machine('A'));
    const key = vault.pendingRecoveryKey();
    expect(() => vault.confirmRecovery(key.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))).toThrow('RECOVERY_KEY_MISMATCH');
    expect(vault.status()).toBe('recovery_pending');

    vault.confirmRecovery(key.toLowerCase().replace(/-/g, ' '));
    expect(vault.status()).toBe('ready');
    expect(() => vault.pendingRecoveryKey()).toThrow('NO_PENDING_RECOVERY');
    const row = vaultRow(db)!;
    expect(row.pending_recovery_local).toBeNull();
    expect(row.recovery_confirmed_at).not.toBeNull();
    expect(openVault(db, machine('A')).status()).toBe('ready');
  });

  test('base copiada para outra máquina fica locked; chave errada não altera nada', () => {
    const dbA = memoryDb();
    const vaultA = openVault(dbA, machine('A'));
    const stored = vaultA.encrypt(CTX, 'senha-original');
    const key = vaultA.pendingRecoveryKey();
    vaultA.confirmRecovery(key);

    const dbB = copyDb(dbA);
    const vaultB = openVault(dbB, machine('B'));
    expect(vaultB.status()).toBe('locked');
    expect(() => vaultB.decrypt(CTX, stored)).toThrow('VAULT_LOCKED');

    const before = vaultRow(dbB);
    const wrong = openVault(memoryDb(), machine('X')).pendingRecoveryKey();
    expect(() => vaultB.unlock(wrong)).toThrow('RECOVERY_KEY_INVALID');
    expect(() => vaultB.unlock('lixo')).toThrow('RECOVERY_KEY_INVALID');
    expect(vaultRow(dbB)).toEqual(before);
    expect(vaultB.status()).toBe('locked');

    vaultB.unlock(key);
    expect(vaultB.status()).toBe('ready');
    expect(vaultB.decrypt(CTX, stored)).toBe('senha-original');
    // O invólucro local passa a ser o da máquina B: o próximo arranque abre sozinho.
    expect(openVault(dbB, machine('B')).decrypt(CTX, stored)).toBe('senha-original');
  });

  test('desbloquear sem proteção local funciona em memória e não escreve', () => {
    const dbA = memoryDb();
    const vaultA = openVault(dbA, machine('A'));
    const stored = vaultA.encrypt(CTX, 'senha');
    const key = vaultA.pendingRecoveryKey();

    const dbDev = copyDb(dbA);
    const dev = openVault(dbDev, noProtection);
    expect(dev.status()).toBe('locked');
    const before = vaultRow(dbDev);
    dev.unlock(key);
    expect(dev.decrypt(CTX, stored)).toBe('senha');
    expect(vaultRow(dbDev)).toEqual(before);
  });

  test('o contexto separa domínios: um valor de settings não abre como PPPoE', () => {
    const vault = openVault(memoryDb(), machine('A'));
    const stored = vault.encrypt('app_settings.routerosPassword', 'x');
    expect(() => vault.decrypt(CTX, stored)).toThrow();
  });

  test('dispose() impede qualquer uso posterior', () => {
    const vault = openVault(memoryDb(), machine('A'));
    vault.dispose();
    expect(() => vault.encrypt(CTX, 'x')).toThrow('VAULT_DISPOSED');
    expect(() => vault.status()).toThrow('VAULT_DISPOSED');
  });

  test('nunca recria em silêncio quando já há ciphertext v2 sem metadados', () => {
    const db = memoryDb();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('routerosPassword', 'enc:v2:a:b:c')").run();
    const vault = openVault(db, machine('A'));
    expect(vault.status()).toBe('locked');
    expect(vaultRow(db)).toBeUndefined();
  });
});
