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

function seedService() {
  const clientId = Number(
    db.prepare(`
      INSERT INTO clients (client_code, full_name, status) VALUES ('C001', 'Sandra', 'active')
    `).run().lastInsertRowid
  );
  db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status, pppoe_username, pppoe_password)
    VALUES (?, 250000, 1, 'active', 'sandra', 'senha-pppoe-da-sandra')
  `).run(clientId);
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
  test('o técnico não a recebe — nem sequer o campo', async () => {
    const admin = await adminToken();
    seedService();
    const tec = await userToken(admin, 'technician');

    const rows = await services(tec);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('pppoePassword');
    // O resto da linha continua lá: o técnico precisa dela para trabalhar.
    expect(rows[0].clientName).toBe('Sandra');
    expect(rows[0].pppoeUsername).toBe('sandra');
    // E não é só o campo: a senha não aparece em lado nenhum do payload.
    expect(JSON.stringify(rows)).not.toContain('senha-pppoe-da-sandra');
  });

  test('quem edita serviços recebe-a — é o campo do formulário', async () => {
    const admin = await adminToken();
    seedService();

    expect((await services(admin))[0].pppoePassword).toBe('senha-pppoe-da-sandra');

    const operador = await userToken(admin, 'operator');
    expect((await services(operador))[0].pppoePassword).toBe('senha-pppoe-da-sandra');
  });
});
