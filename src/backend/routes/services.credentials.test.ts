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

describe('mostrar a senha PPPoE', () => {
  const reveal = (id: number, token: string, password?: string) => app.inject({
    method: 'POST',
    url: `/api/services/${id}/pppoe-password/reveal`,
    headers: { authorization: `Bearer ${token}` },
    payload: password === undefined ? {} : { password }
  });

  test('o admin que confirma a password recebe a senha, e a consulta fica auditada sem ela', async () => {
    const admin = await adminToken();
    const id = seedService();

    const response = await reveal(id, admin, 'supersecret');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ username: 'sandra', password: MARCADOR });
    expect(response.headers['cache-control']).toBe('no-store');

    const audit = db.prepare(`SELECT summary, metadata_json AS meta FROM audit_logs WHERE action = 'reveal_pppoe_password'`).all();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(MARCADOR);
  });

  test('sem a password, ou com ela errada, não revela nada', async () => {
    const admin = await adminToken();
    const id = seedService();

    for (const attempt of [undefined, 'password-errada']) {
      const response = await reveal(id, admin, attempt);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(MARCADOR);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'reveal_pppoe_password'`).get()).toEqual({ n: 0 });
  });

  test('operador e técnico não chegam à senha, nem com a password deles', async () => {
    const admin = await adminToken();
    const id = seedService();
    for (const role of ['operator', 'technician'] as const) {
      const response = await reveal(id, await userToken(admin, role), `${role}-pw-1`);
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(MARCADOR);
    }
  });

  test('serviço sem senha responde 409', async () => {
    const admin = await adminToken();
    const id = seedService();
    db.prepare('UPDATE services SET pppoe_password = NULL WHERE id = ?').run(id);
    expect((await reveal(id, admin, 'supersecret')).statusCode).toBe(409);
  });
});

describe('criar PPPoE num serviço que não o tem', () => {
  function seedBare(code: string): number {
    const clientId = Number(db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES (?, 'Isa Rafe', 'active')`).run(code).lastInsertRowid);
    return Number(db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 250000, 1, 'active')`).run(clientId).lastInsertRowid);
  }

  const create = (id: number, token: string, username?: string) => app.inject({
    method: 'POST',
    url: `/api/services/${id}/pppoe`,
    headers: { authorization: `Bearer ${token}` },
    payload: username === undefined ? {} : { username }
  });

  test('com nome indicado grava-o, com senha selada e pendente', async () => {
    const admin = await adminToken();
    const id = seedBare('C0001');

    const response = await create(id, admin, 'skn014');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ username: 'skn014' });
    expect(storedPassword(id).p?.startsWith('enc:v2:')).toBe(true);
    expect(storedPassword(id).pending).toBe(1);
    expect(readPppoeSecret(db, id).length).toBeGreaterThanOrEqual(8);
    expect(response.body).not.toContain(readPppoeSecret(db, id));
  });

  test('sem nome usa o automático, e o prefixo manda', async () => {
    const admin = await adminToken();
    const id = seedBare('C0007');
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('routerosPppoePrefix', 'skn')`).run();
    try {
      expect((await create(id, admin)).json()).toEqual({ username: 'skn007' });
    } finally {
      db.prepare(`DELETE FROM app_settings WHERE key = 'routerosPppoePrefix'`).run();
    }
  });

  test('recusa um nome de outro serviço e um serviço que já tem PPPoE', async () => {
    const admin = await adminToken();
    const taken = seedService();
    const id = seedBare('C0002');

    const clash = await create(id, admin, 'sandra');
    expect(clash.statusCode).toBe(409);
    expect(storedPassword(id).p).toBeNull();

    const before = storedPassword(taken);
    expect((await create(taken, admin, 'outro')).statusCode).toBe(409);
    expect(storedPassword(taken)).toEqual(before);
  });

  test('o técnico não cria', async () => {
    const admin = await adminToken();
    const id = seedBare('C0003');
    expect((await create(id, await userToken(admin, 'technician'))).statusCode).toBe(403);
  });
});
