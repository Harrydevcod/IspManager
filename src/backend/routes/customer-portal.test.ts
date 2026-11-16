import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let dir: string;
let close: () => void;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ispm-portal-test-'));
  process.env.ISPM_DATA_DIR = dir;
  process.env.ISPM_AUTO_BILLING = 'off';
  const server = await import('../server');
  const db = await import('../db/database');
  app = await server.createBackendApp(); await app.ready(); close = db.closeDatabaseForTests;
});
afterAll(async () => { await app.close(); close(); rmSync(dir, { recursive: true, force: true }); delete process.env.ISPM_DATA_DIR; delete process.env.ISPM_AUTO_BILLING; });

test('only an administrator can create, list or revoke customer links', async () => {
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' } });
  const admin = setup.json().token as string;
  const headers = { authorization: `Bearer ${admin}` };
  const user = await app.inject({ method: 'POST', url: '/api/users', headers, payload: { username: 'operator', password: 'operatorpw', fullName: 'Operador', role: 'operator' } });
  expect(user.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operatorpw' } });
  const operator = { authorization: `Bearer ${login.json().token}` };
  for (const [method, url] of [['GET', '/api/clients/1/portal-links'], ['POST', '/api/clients/1/portal-links'], ['DELETE', `/api/clients/1/portal-links/${'a'.repeat(64)}`]] as const) {
    expect((await app.inject({ method, url })).statusCode).toBe(401);
    expect((await app.inject({ method, url, headers: operator })).statusCode).toBe(403);
  }
  expect((await app.inject({ method: 'POST', url: '/api/clients/1/portal-links', headers })).statusCode).toBe(409);
});
