import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabaseForTests, getSqliteDatabase } from '../db/database';
import { canStoreSecrets, getCredentialVault } from './secrets';
import { createBackup } from './backup';

const protection = {
  available: () => true,
  seal: (value: string) => `test:${value}`,
  open: (value: string) => value.slice(5)
};
let dir: string;

afterEach(() => {
  closeDatabaseForTests();
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_AUTO_BILLING;
});

describe('arranque do cofre', () => {
  test('restauro noutra proteção entra trancado e desbloqueia sem perder o backup', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ispm-vault-other-machine-'));
    process.env.ISPM_DATA_DIR = dir;
    process.env.ISPM_AUTH = 'off';
    process.env.ISPM_AUTO_BILLING = 'off';
    const machine = (id: string) => ({
      available: () => true,
      seal: (value: string) => `${id}:${value}`,
      open: (stored: string) => { if (!stored.startsWith(`${id}:`)) throw new Error('OTHER_MACHINE'); return stored.slice(id.length + 1); }
    });
    const { createBackendApp } = await import('../server');
    const first = await createBackendApp({ localProtection: machine('A') });
    const key = getCredentialVault()!.pendingRecoveryKey();
    getCredentialVault()!.confirmRecovery(key);
    await first.close();
    closeDatabaseForTests();

    const second = await createBackendApp({ localProtection: machine('B') });
    try {
      expect((await second.inject({ method: 'GET', url: '/api/vault/status' })).json().status).toBe('locked');
      await expect(createBackup('manual')).rejects.toThrow('BACKUP_BLOCKED_BY_VAULT');
      const unlocked = await second.inject({ method: 'POST', url: '/api/vault/unlock', payload: { recoveryKey: key } });
      expect(unlocked.statusCode).toBe(200);
      expect(unlocked.json().status).toBe('ready');
      expect(canStoreSecrets()).toBe(true);
      await expect(createBackup('manual')).resolves.toHaveProperty('file');
    } finally { await second.close(); }
  });

  test('migração inválida mantém API comercial mas suspende segredos e backups', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ispm-vault-startup-'));
    process.env.ISPM_DATA_DIR = dir;
    process.env.ISPM_AUTH = 'off';
    process.env.ISPM_AUTO_BILLING = 'off';
    const db = getSqliteDatabase();
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('ultraMsgToken', 'enc:desconhecido', datetime('now'))").run();
    closeDatabaseForTests();
    const { createBackendApp } = await import('../server');
    const app = await createBackendApp({ localProtection: protection });
    try {
      const status = await app.inject({ method: 'GET', url: '/api/vault/status' });
      expect(status.statusCode).toBe(200);
      expect(status.json().migrationError).toContain('ultraMsgToken');
      expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).statusCode).toBe(200);
      expect(canStoreSecrets()).toBe(false);
      await expect(createBackup('manual')).rejects.toThrow('BACKUP_BLOCKED_BY_VAULT');
    } finally { await app.close(); }
  });
});
