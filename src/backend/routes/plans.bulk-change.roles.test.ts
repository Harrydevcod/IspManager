/**
 * Quem pode mudar de plano. Auth a sério (sem `ISPM_AUTH=off`): um serviço de
 * cada vez é de quem já o pode editar; vários de uma vez é só de administrador.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let dataDir: string;
let closeDatabaseForTests: () => void;
let admin: string;
let operator: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-bulk-change-roles-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  delete process.env.ISPM_AUTH;

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  closeDatabaseForTests = database.closeDatabaseForTests;

  const db = database.getSqliteDatabase();
  db.prepare(`INSERT INTO internet_plans (id, name, monthly_price_cve, router_profile, active) VALUES (1, 'Base 10', 2500, 'plano-10M', 1), (2, 'Mais 20', 3500, 'plano-20M', 1)`).run();
  db.prepare(`INSERT INTO clients (id, client_code, full_name) VALUES (1, 'C0001', 'Joao Silva'), (2, 'C0002', 'Ana Lopes')`).run();
  db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username) VALUES (1, 1, 1, 2500, 'active', 'skn001'), (2, 2, 1, 2500, 'active', 'skn002')`).run();

  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' } });
  admin = setup.json().token;
  await app.inject({
    method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${admin}` },
    payload: { username: 'operator', password: 'operator-pw-1', fullName: 'Operador', role: 'operator' }
  });
  operator = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operator-pw-1' } })).json().token;
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

const post = (token: string, url: string, serviceIds: number[]) => app.inject({
  method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: { serviceIds, targetPlanId: 2 }
});

test('o operador muda o plano de um serviço, como já fazia pela edição', async () => {
  expect((await post(operator, '/api/plans/bulk-change/preview', [1])).statusCode).toBe(200);
  // Sem router configurado a execução pára no 409 — já depois da permissão.
  expect((await post(operator, '/api/plans/bulk-change', [1])).statusCode).toBe(409);
});

test('vários serviços de uma vez é só de administrador', async () => {
  for (const url of ['/api/plans/bulk-change/preview', '/api/plans/bulk-change']) {
    const refused = await post(operator, url, [1, 2]);
    expect([url, refused.statusCode]).toEqual([url, 403]);
    expect(refused.json().error).toContain('administradores');
  }
  expect((await post(admin, '/api/plans/bulk-change/preview', [1, 2])).statusCode).toBe(200);
});

test('o histórico continua só de administrador', async () => {
  expect((await app.inject({ url: '/api/plans/bulk-change', headers: { authorization: `Bearer ${operator}` } })).statusCode).toBe(403);
});
