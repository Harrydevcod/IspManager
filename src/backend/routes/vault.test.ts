import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify from 'fastify';
import { registerVaultRoutes } from './vault';
import type { Vault } from '../lib/vault';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let dir: string;
let token: string;
let key: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ispm-vault-route-'));
  process.env.ISPM_DATA_DIR = dir;
  process.env.ISPM_AUTO_BILLING = 'off';
  const { createBackendApp } = await import('../server');
  app = await createBackendApp({ localProtection: {
    available: () => true,
    seal: (value: string) => `test:${value}`,
    open: (value: string) => value.slice(5)
  } });
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' } });
  token = setup.json().token;
});

afterAll(async () => {
  await app.close();
  (await import('../db/database')).closeDatabaseForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
});

const headers = () => ({ authorization: `Bearer ${token}` });

describe('rotas do cofre', () => {
  test('operador e técnico não acedem a nenhuma rota', async () => {
    for (const role of ['operator', 'technician'] as const) {
      const username = role === 'operator' ? 'op1' : 'tec1';
      const created = await app.inject({ method: 'POST', url: '/api/users', headers: headers(), payload: { username, password: 'userpassword', fullName: username, role } });
      expect(created.statusCode).toBe(201);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'userpassword' } });
      const deniedHeaders = { authorization: `Bearer ${login.json().token}` };
      for (const [method, url] of [['GET', '/api/vault/status'], ['POST', '/api/vault/recovery-key'], ['POST', '/api/vault/confirm'], ['POST', '/api/vault/unlock']] as const) {
        const res = await app.inject({ method, url, headers: deniedHeaders, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(res.statusCode).toBe(403);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
  });
  test('estado não expõe chaves e é privado', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/vault/status' });
    expect(denied.statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/vault/status', headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ status: 'recovery_pending' });
  });

  test('entrega exige a palavra-passe atual e só existe enquanto pendente', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/vault/recovery-key', headers: headers(), payload: { password: 'errada' } });
    expect(wrong.statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/api/vault/recovery-key', headers: headers(), payload: { password: 'supersecret' } });
    expect(res.statusCode).toBe(200);
    key = res.json().recoveryKey;
    expect(key).toMatch(/^ISPM-/);
    const mismatch = await app.inject({ method: 'POST', url: '/api/vault/confirm', headers: headers(), payload: { recoveryKey: 'ISPM-ERRADA' } });
    expect(mismatch.statusCode).toBe(400);
    const confirmed = await app.inject({ method: 'POST', url: '/api/vault/confirm', headers: headers(), payload: { recoveryKey: key } });
    expect(confirmed.statusCode).toBe(200);
    const repeated = await app.inject({ method: 'POST', url: '/api/vault/recovery-key', headers: headers(), payload: { password: 'supersecret' } });
    expect(repeated.statusCode).toBe(409);
  });
});

test('desbloqueio bloqueia após cinco chaves erradas', async () => {
  const isolated = Fastify({ logger: false });
  const locked = {
    status: () => 'locked' as const,
    unlock: () => { throw new Error('RECOVERY_KEY_INVALID'); }
  } as unknown as Vault;
  isolated.addHook('preHandler', async (request) => { request.user = { id: 1, username: 'admin', fullName: 'Admin', role: 'admin' }; });
  await registerVaultRoutes(isolated, locked);
  for (let i = 0; i < 5; i++) {
    const res = await isolated.inject({ method: 'POST', url: '/api/vault/unlock', payload: { recoveryKey: 'ISPM-ERRADA' } });
    expect(res.statusCode).toBe(400);
  }
  const limited = await isolated.inject({ method: 'POST', url: '/api/vault/unlock', payload: { recoveryKey: 'ISPM-ERRADA' } });
  expect(limited.statusCode).toBe(429);
  await isolated.close();
});

test('o body com a chave nunca aparece nos logs', async () => {
  const lines: string[] = [];
  const isolated = Fastify({ logger: { level: 'info', stream: { write: (line: string) => { lines.push(line); } } } });
  const locked = { status: () => 'locked' as const, unlock: () => { throw new Error('RECOVERY_KEY_INVALID'); } } as unknown as Vault;
  isolated.addHook('preHandler', async (request) => { request.user = { id: 1, username: 'admin', fullName: 'Admin', role: 'admin' }; });
  await registerVaultRoutes(isolated, locked);
  const marker = 'ISPM-SEGREDO-MARCADOR-123';
  await isolated.inject({ method: 'POST', url: '/api/vault/unlock', payload: { recoveryKey: marker } });
  await isolated.close();
  expect(lines.join('')).not.toContain(marker);
});

test('confirmação bloqueia após cinco chaves erradas', async () => {
  const isolated = Fastify({ logger: false });
  const pending = { status: () => 'recovery_pending' as const, confirmRecovery: () => { throw new Error('RECOVERY_KEY_MISMATCH'); } } as unknown as Vault;
  isolated.addHook('preHandler', async (request) => { request.user = { id: 1, username: 'admin', fullName: 'Admin', role: 'admin' }; });
  await registerVaultRoutes(isolated, pending);
  for (let i = 0; i < 5; i++) {
    const res = await isolated.inject({ method: 'POST', url: '/api/vault/confirm', payload: { recoveryKey: 'ISPM-ERRADA' } });
    expect(res.statusCode).toBe(400);
  }
  const limited = await isolated.inject({ method: 'POST', url: '/api/vault/confirm', payload: { recoveryKey: 'ISPM-ERRADA' } });
  expect(limited.statusCode).toBe(429);
  await isolated.close();
});
