import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { fakeMachine } from './credentials.testing';
import { createLocalProtection } from './local-protection';
import { openVault } from './vault';
import { migrateCredentials } from './vault-migration';

const machineA = fakeMachine('A');

function memoryDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function setting(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

function raw(db: Database.Database, key: string): string {
  return (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';
}

let seq = 0;
function addService(db: Database.Database, password: string | null, pending = 0): number {
  const client = db.prepare("INSERT INTO clients (client_code, full_name) VALUES (?, 'Cliente')").run(`C${++seq}`).lastInsertRowid;
  return Number(db.prepare(`
    INSERT INTO services (client_id, pppoe_username, pppoe_password, pppoe_password_sync_pending)
    VALUES (?, ?, ?, ?)
  `).run(client, `user${seq}`, password, pending).lastInsertRowid);
}

function servicePassword(db: Database.Database, id: number) {
  return db.prepare('SELECT pppoe_password AS p, pppoe_password_sync_pending AS pending FROM services WHERE id = ?').get(id) as {
    p: string | null;
    pending: number;
  };
}

describe('migrateCredentials', () => {
  test('converte texto simples e enc:v1 que abre; preserva bytes e não toca em flags', () => {
    const db = memoryDb();
    setting(db, 'routerosPassword', '  senha com espaços ');
    setting(db, 'ultraMsgToken', machineA.seal('token-selado'));
    setting(db, 'companyName', 'SKYNET');
    const svc = addService(db, 'pppoe-1', 1);
    const empty = addService(db, '');
    const nulo = addService(db, null);

    const vault = openVault(db, machineA);
    expect(migrateCredentials(db, vault, machineA)).toEqual({ ok: true, converted: 3 });

    for (const key of ['routerosPassword', 'ultraMsgToken']) expect(raw(db, key).startsWith('enc:v2:')).toBe(true);
    expect(vault.decrypt('app_settings.routerosPassword', raw(db, 'routerosPassword'))).toBe('  senha com espaços ');
    expect(vault.decrypt('app_settings.ultraMsgToken', raw(db, 'ultraMsgToken'))).toBe('token-selado');
    const row = servicePassword(db, svc);
    expect(vault.decrypt('services.pppoe_password', row.p!)).toBe('pppoe-1');
    expect(row.pending).toBe(1);
    expect(servicePassword(db, empty).p).toBe('');
    expect(servicePassword(db, nulo).p).toBeNull();
    expect(raw(db, 'companyName')).toBe('SKYNET');
  });

  test('reexecução depois de sucesso é idempotente', () => {
    const db = memoryDb();
    setting(db, 'routerosPassword', 'senha');
    addService(db, 'pppoe');
    const vault = openVault(db, machineA);
    migrateCredentials(db, vault, machineA);
    const before = db.serialize();
    expect(migrateCredentials(db, vault, machineA)).toEqual({ ok: true, converted: 0 });
    expect(db.serialize().equals(before)).toBe(true);
  });

  test('uma linha inválida aborta tudo e preserva todas as outras', () => {
    for (const bad of [fakeMachine('OUTRA').seal('de-outra-maquina'), 'enc:v9:desconhecido']) {
      const db = memoryDb();
      setting(db, 'routerosPassword', 'senha-em-claro');
      const svc = addService(db, 'pppoe-em-claro');
      setting(db, 'ultraMsgToken', bad);

      const result = migrateCredentials(db, openVault(db, machineA), machineA);
      expect(result).toMatchObject({ ok: false, field: 'app_settings.ultraMsgToken' });
      expect(JSON.stringify(result)).not.toContain('senha');
      expect(raw(db, 'routerosPassword')).toBe('senha-em-claro');
      expect(raw(db, 'ultraMsgToken')).toBe(bad);
      expect(servicePassword(db, svc).p).toBe('pppoe-em-claro');
    }
  });

  test('a falha num serviço identifica o id, nunca o conteúdo', () => {
    const db = memoryDb();
    const svc = addService(db, 'enc:zz:lixo-secreto');
    const result = migrateCredentials(db, openVault(db, machineA), machineA);
    expect(result).toEqual({ ok: false, field: `services.pppoe_password#${svc}`, reason: 'UNKNOWN_ENVELOPE' });
  });

  test('cofre trancado ou ausente: não faz nada', () => {
    const db = memoryDb();
    setting(db, 'routerosPassword', 'senha');
    const absent = openVault(db, createLocalProtection(null));
    expect(migrateCredentials(db, absent, createLocalProtection(null))).toEqual({ ok: false, field: 'vault', reason: 'absent' });
    expect(raw(db, 'routerosPassword')).toBe('senha');
  });
});
