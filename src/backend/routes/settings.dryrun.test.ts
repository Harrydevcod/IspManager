/**
 * Desligar o ensaio do router é a gravação que arma cortes a sério no MikroTik.
 *
 * Auth a sério neste ficheiro (sem `ISPM_AUTH=off`): o que se testa é que a
 * passagem ensaio → efetivo exige admin E a password dele outra vez, e que a
 * direção segura (voltar a ensaio) continua livre.
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-settings-dryrun-'));
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
  db.prepare(`DELETE FROM app_settings WHERE key = 'routerosDryRun'`).run();
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
    payload: { username: 'operator', password: 'operator-pw-1', fullName: 'Operador', role: 'operator' }
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'operator', password: 'operator-pw-1' }
  });
  return login.json().token as string;
}

/** Como o ecrã faz: lê o que está gravado e devolve-o com a alteração. */
async function save(token: string, extra: Record<string, unknown>) {
  const headers = { authorization: `Bearer ${token}` };
  const current = await app.inject({ method: 'GET', url: '/api/settings', headers });
  const { secretsLost: _ignored, ...settings } = current.statusCode === 200 ? current.json() : { secretsLost: null };
  return app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers,
    payload: { ...settings, companyName: 'ISPM', defaultDueDay: 1, ...extra }
  });
}

function storedDryRun(): string | undefined {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'routerosDryRun'`).get() as { value: string } | undefined;
  return row?.value;
}

function auditSummaries(): string[] {
  return (db.prepare(`SELECT summary FROM audit_logs WHERE entity_type = 'settings' ORDER BY id`).all() as Array<{ summary: string }>)
    .map((row) => row.summary);
}

describe('passar o router a modo efetivo', () => {
  test('sem password o admin não desliga o ensaio', async () => {
    const admin = await adminToken();
    const response = await save(admin, { routerosDryRun: false });
    expect(response.statusCode).toBe(400);
    expect(storedDryRun()).toBeUndefined();
  });

  test('com a password errada não desliga o ensaio', async () => {
    const admin = await adminToken();
    const response = await save(admin, { routerosDryRun: false, confirmPassword: 'errada' });
    // 403, não 401: a sessão continua válida, só a confirmação falhou.
    expect(response.statusCode).toBe(403);
    expect(storedDryRun()).toBeUndefined();
  });

  test('com a password certa desliga, e a auditoria regista a passagem', async () => {
    const admin = await adminToken();
    const response = await save(admin, { routerosDryRun: false, confirmPassword: 'supersecret' });
    expect(response.statusCode).toBe(200);
    expect(storedDryRun()).toBe('false');
    expect(auditSummaries()).toContain('Passou o router de ensaio para modo efetivo');
    // A password de confirmação nunca é gravada como definição.
    const leaked = db.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key = 'confirmPassword'`).get() as { n: number };
    expect(leaked.n).toBe(0);
  });

  test('já em efetivo, gravar outras definições não pede password outra vez', async () => {
    const admin = await adminToken();
    expect((await save(admin, { routerosDryRun: false, confirmPassword: 'supersecret' })).statusCode).toBe(200);
    const response = await save(admin, { routerosDryRun: false, companyName: 'Outro nome' });
    expect(response.statusCode).toBe(200);
  });

  test('voltar a ensaio é livre', async () => {
    const admin = await adminToken();
    expect((await save(admin, { routerosDryRun: false, confirmPassword: 'supersecret' })).statusCode).toBe(200);
    const response = await save(admin, { routerosDryRun: true });
    expect(response.statusCode).toBe(200);
    expect(storedDryRun()).toBe('true');
    expect(auditSummaries()).toContain('Voltou o router a ensaio');
  });

  test('gravar com o ensaio ligado não pede password', async () => {
    const admin = await adminToken();
    expect((await save(admin, { routerosDryRun: true })).statusCode).toBe(200);
  });

  test('um operador não chega sequer a gravar', async () => {
    const operator = await operatorToken(await adminToken());
    const response = await save(operator, { routerosDryRun: false, confirmPassword: 'operator-pw-1' });
    expect(response.statusCode).toBe(403);
    expect(storedDryRun()).toBeUndefined();
  });
});
