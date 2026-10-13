/**
 * Quem pode reembolsar um pagamento Stripe.
 *
 * Auth a sério neste ficheiro (sem `ISPM_AUTH=off`): é dinheiro a sair, por
 * isso só o admin, e com a password outra vez. As recusas têm de acontecer
 * antes de se olhar para o recibo — e muito antes de falar com o Stripe.
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

const REASON = 'Cliente pagou a fatura errada';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-stripe-refund-roles-'));
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

async function operatorToken(admin: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { authorization: `Bearer ${admin}` },
    payload: { username: 'operator', password: 'operator-pw-1', fullName: 'operator', role: 'operator' }
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operator-pw-1' } });
  return login.json().token as string;
}

const refund = (token: string, confirmPassword?: string) => app.inject({
  method: 'POST',
  url: '/api/receipts/999/stripe-refund',
  headers: { authorization: `Bearer ${token}` },
  payload: { reason: REASON, confirmPassword }
});

describe('reembolso Stripe', () => {
  test('um operador não reembolsa', async () => {
    const op = await operatorToken(await adminToken());
    expect((await refund(op, 'operator-pw-1')).statusCode).toBe(403);
  });

  test('o admin sem a password certa é recusado antes de se olhar para o recibo', async () => {
    const admin = await adminToken();

    const missing = await refund(admin);
    const wrong = await refund(admin, 'nao-e-esta');

    // 404 queria dizer que se chegou a procurar o recibo.
    expect([400, 401, 403]).toContain(missing.statusCode);
    expect([400, 401, 403]).toContain(wrong.statusCode);
  });

  test('o admin com a password passa a guarda e chega ao recibo', async () => {
    const admin = await adminToken();
    expect((await refund(admin, 'supersecret')).statusCode).toBe(404);
  });
});
