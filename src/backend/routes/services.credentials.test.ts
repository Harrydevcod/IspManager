/**
 * Quem recebe a senha PPPoE dos clientes.
 *
 * Auth a sério neste ficheiro (sem `ISPM_AUTH=off`): a regra que se testa é
 * precisamente a de papéis. A lista de serviços trazia a credencial de acesso à
 * rede de **todos** os clientes para qualquer sessão aberta — incluindo o papel
 * técnico, que nem sequer pode escrever serviços.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getCredentialVault, readPppoeSecret, setCredentialVault, writePppoeSecret } from '../lib/secrets';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let resetAuthSecretCache: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-services-credentials-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  delete process.env.ISPM_AUTH;

  const server = await import('../server');
  const database = await import('../db/database');
  const authLib = await import('../lib/auth');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  resetAuthSecretCache = authLib.resetAuthSecretCache;
});

beforeEach(() => {
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM login_throttle').run();
  db.prepare('DELETE FROM audit_logs').run();
  db.prepare('DELETE FROM users').run();
  resetAuthSecretCache();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

async function adminToken() {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' }
  });
  expect(setup.statusCode).toBe(201);
  return setup.json().token as string;
}

async function userToken(admin: string, role: 'operator' | 'technician') {
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { authorization: `Bearer ${admin}` },
    payload: { username: role, password: `${role}-pw-1`, fullName: role, role }
  });
  expect(created.statusCode).toBe(201);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: role, password: `${role}-pw-1` }
  });
  expect(login.statusCode).toBe(200);
  return login.json().token as string;
}

const MARCADOR = 'senha-pppoe-da-sandra';

function seedService(): number {
  const clientId = Number(
    db.prepare(`
      INSERT INTO clients (client_code, full_name, status) VALUES ('C001', 'Sandra', 'active')
    `).run().lastInsertRowid
  );
  const serviceId = Number(db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status, pppoe_username)
    VALUES (?, 250000, 1, 'active', 'sandra')
  `).run(clientId).lastInsertRowid);
  writePppoeSecret(db, serviceId, MARCADOR);
  return serviceId;
}

function storedPassword(id: number) {
  return db.prepare('SELECT pppoe_password AS p, pppoe_password_sync_pending AS pending FROM services WHERE id = ?').get(id) as {
    p: string | null;
    pending: number;
  };
}

async function services(token: string) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/services',
    headers: { authorization: `Bearer ${token}` }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Array<Record<string, unknown>>;
}

describe('senha PPPoE na lista de serviços', () => {
  test('nenhum papel a recebe — só a indicação de que existe', async () => {
    const admin = await adminToken();
    seedService();
    const operador = await userToken(admin, 'operator');
    const tec = await userToken(admin, 'technician');

    for (const token of [admin, operador, tec]) {
      const rows = await services(token);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('pppoePassword');
      expect(rows[0].pppoePasswordConfigured).toBe(true);
      expect(rows[0].pppoeUsername).toBe('sandra');
      expect(JSON.stringify(rows)).not.toContain(MARCADOR);
    }
  });

  test('na base fica cifrada', async () => {
    await adminToken();
    const id = seedService();
    expect(storedPassword(id).p?.startsWith('enc:v2:')).toBe(true);
    expect(readPppoeSecret(db, id)).toBe(MARCADOR);
  });
});

describe('escrever a senha PPPoE', () => {
  function payload(extra: Record<string, unknown> = {}) {
    const clientId = (db.prepare('SELECT id FROM clients').get() as { id: number }).id;
    return { clientId, monthlyValueCve: 3000, dueDay: 1, status: 'active', pppoeUsername: 'sandra', ...extra };
  }

  test('editar só o preço preserva o ciphertext byte a byte e não marca pendente', async () => {
    const admin = await adminToken();
    const id = seedService();
    db.prepare('UPDATE services SET pppoe_password_sync_pending = 0 WHERE id = ?').run(id);
    const before = storedPassword(id).p;

    for (const extra of [{}, { pppoePassword: '' }, { pppoePassword: null }]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/services/${id}`,
        headers: { authorization: `Bearer ${admin}` },
        payload: payload(extra)
      });
      expect(response.statusCode).toBe(200);
      expect(storedPassword(id)).toEqual({ p: before, pending: 0 });
    }
  });

  test('uma senha nova substitui, preserva bytes e fica pendente para o router', async () => {
    const admin = await adminToken();
    const id = seedService();
    db.prepare('UPDATE services SET pppoe_password_sync_pending = 0 WHERE id = ?').run(id);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/services/${id}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: payload({ pppoePassword: ' nova senha ' })
    });
    expect(response.statusCode).toBe(200);
    expect(readPppoeSecret(db, id)).toBe(' nova senha ');
    expect(storedPassword(id).pending).toBe(1);
  });

  test('senha nova fora de 8–64 é recusada e nada muda', async () => {
    const admin = await adminToken();
    const id = seedService();
    const before = storedPassword(id).p;
    const response = await app.inject({
      method: 'PUT',
      url: `/api/services/${id}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: payload({ pppoePassword: 'curta', monthlyValueCve: 9999 })
    });
    expect(response.statusCode).toBe(400);
    expect(storedPassword(id).p).toBe(before);
  });

  test('a ação dedicada cifra a senha nova; auditoria nunca a mostra', async () => {
    const admin = await adminToken();
    const id = seedService();
    const nova = 'marcador-nova-senha-42';
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/services/${id}/pppoe-password`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { password: nova }
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(nova);
    expect(readPppoeSecret(db, id)).toBe(nova);
    expect(storedPassword(id).p).not.toContain(nova);
    const audit = JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());
    expect(audit).not.toContain(nova);
    expect(audit).not.toContain(MARCADOR);
  });

  test('com o cofre trancado, escrever uma senha responde 409 e não toca na base', async () => {
    const admin = await adminToken();
    const id = seedService();
    const before = storedPassword(id);
    const vault = getCredentialVault();
    setCredentialVault(null);
    try {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/services/${id}`,
        headers: { authorization: `Bearer ${admin}` },
        payload: payload({ pppoePassword: 'outra-senha-longa', monthlyValueCve: 7777 })
      });
      expect(put.statusCode).toBe(409);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/services/${id}/pppoe-password`,
        headers: { authorization: `Bearer ${admin}` },
        payload: { password: 'outra-senha-longa' }
      });
      expect(patch.statusCode).toBe(409);
    } finally {
      setCredentialVault(vault);
    }
    expect(storedPassword(id)).toEqual(before);
    const price = db.prepare('SELECT monthly_value_cve AS v FROM services WHERE id = ?').get(id) as { v: number };
    expect(price.v).not.toBe(777700);
  });
});
