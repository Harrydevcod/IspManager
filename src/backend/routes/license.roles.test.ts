/**
 * Quem pode ativar e quem pode remover a licença.
 *
 * Auth a sério neste ficheiro (sem `ISPM_AUTH=off`): a regra que se testa é
 * precisamente a de papéis. Ativar é aberto por decisão de produto; remover
 * fica no admin porque é a ação que põe a instalação em leitura-apenas.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { licenseClaimSchema, toIsoDate } from '../../shared/license';
import { generateLicenseKeyPair, signLicense } from '../lib/license-signature';
import { resetLicenseCache } from '../lib/license';

const keys = generateLicenseKeyPair();

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let resetAuthSecretCache: () => void;

function token(id = 'LIC-2026-0001') {
  return signLicense(
    licenseClaimSchema.parse({
      v: 1,
      id,
      customer: 'Nova Tech, Lda',
      kind: 'subscricao',
      bind: 'none',
      issuedAt: toIsoDate(new Date()),
      expiresAt: toIsoDate(new Date(Date.now() + 365 * 86_400_000))
    }),
    keys.privateKey
  );
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-license-roles-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  process.env.ISPM_LICENSE_PUBLIC_KEY = keys.publicKey;
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
  resetLicenseCache();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
  delete process.env.ISPM_LICENSE_PUBLIC_KEY;
  resetLicenseCache();
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

describe('ativar', () => {
  test('um técnico pode ativar', async () => {
    const tec = await userToken(await adminToken(), 'technician');
    const response = await app.inject({
      method: 'POST',
      url: '/api/license',
      headers: { authorization: `Bearer ${tec}` },
      payload: { token: token() }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe('active');
  });

  test('um operador pode ativar', async () => {
    const op = await userToken(await adminToken(), 'operator');
    const response = await app.inject({
      method: 'POST',
      url: '/api/license',
      headers: { authorization: `Bearer ${op}` },
      payload: { token: token('LIC-2026-0002') }
    });
    expect(response.statusCode).toBe(200);
  });

  test('numa instalação nova, ainda sem contas, também se pode ativar', async () => {
    // Sem esta exceção, uma máquina cuja avaliação expirou antes do setup
    // ficava sem saída: ativar exigiria uma conta que ainda não existe.
    const response = await app.inject({
      method: 'POST',
      url: '/api/license',
      payload: { token: token('LIC-2026-0003') }
    });
    expect(response.statusCode).toBe(200);
  });

  test('a auditoria regista quem ativou', async () => {
    const tec = await userToken(await adminToken(), 'technician');
    await app.inject({
      method: 'POST',
      url: '/api/license',
      headers: { authorization: `Bearer ${tec}` },
      payload: { token: token('LIC-2026-0004') }
    });

    const row = db
      .prepare(`SELECT actor_username, action, entity_id FROM audit_logs WHERE entity_type = 'license'`)
      .get() as { actor_username: string; action: string; entity_id: string };
    expect(row).toMatchObject({ actor_username: 'technician', action: 'activate', entity_id: 'LIC-2026-0004' });
  });
});

describe('remover', () => {
  test('um técnico não pode remover', async () => {
    const tec = await userToken(await adminToken(), 'technician');
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/license',
      headers: { authorization: `Bearer ${tec}` }
    });
    expect(response.statusCode).toBe(403);
  });

  test('um operador não pode remover', async () => {
    const op = await userToken(await adminToken(), 'operator');
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/license',
      headers: { authorization: `Bearer ${op}` }
    });
    expect(response.statusCode).toBe(403);
  });

  test('sem sessão não se remove', async () => {
    await adminToken();
    const response = await app.inject({ method: 'DELETE', url: '/api/license' });
    expect(response.statusCode).toBe(401);
  });

  test('o admin remove', async () => {
    const admin = await adminToken();
    await app.inject({
      method: 'POST',
      url: '/api/license',
      headers: { authorization: `Bearer ${admin}` },
      payload: { token: token('LIC-2026-0005') }
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/license',
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().license).toBeNull();
  });
});

describe('consultar', () => {
  test('o estado é legível sem sessão — o ecrã aparece antes do login', async () => {
    await adminToken();
    const response = await app.inject({ method: 'GET', url: '/api/license' });
    expect(response.statusCode).toBe(200);
    expect(response.json().enabled).toBe(true);
  });
});
