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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-auth-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  // Intentionally do NOT set ISPM_AUTH=off — we want real auth in this file.

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
  db.prepare('DELETE FROM work_orders').run();
  db.prepare('DELETE FROM service_events').run();
  db.prepare('DELETE FROM service_device_assignments').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM stock_movements').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM app_settings').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM users').run();
  resetAuthSecretCache();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
});

describe('auth flow', () => {
  async function setupAdminToken() {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' }
    });
    return setup.json().token as string;
  }

  async function createUserAndLogin(adminToken: string, role: 'operator' | 'technician') {
    const username = role === 'operator' ? 'op1' : 'tec1';
    const password = role === 'operator' ? 'operatorpw' : 'technicianpw';
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username,
        password,
        fullName: role === 'operator' ? 'Operadora' : 'Tecnico',
        role
      }
    });
    expect(created.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password }
    });
    expect(login.statusCode).toBe(200);
    return login.json().token as string;
  }

  test('GET /auth/status reports setupRequired when no users exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ setupRequired: true, authBypassed: false });
  });

  test('POST /auth/setup creates first admin, refuses second call, login works after', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'supersecret', fullName: 'Admin Principal' }
    });
    expect(first.statusCode).toBe(201);
    const setup = first.json();
    expect(setup.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(setup.user).toEqual({ id: expect.any(Number), username: 'admin', fullName: 'Admin Principal', role: 'admin' });

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin2', password: 'supersecret', fullName: 'Outro' }
    });
    expect(second.statusCode).toBe(409);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'supersecret' }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe('admin');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' }
    });
    expect(bad.statusCode).toBe(401);
  });

  test('protected endpoints require token and role', async () => {
    const adminToken = await setupAdminToken();

    // Create operator user as admin
    const operatorCreate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username: 'op1',
        password: 'operatorpw',
        fullName: 'Operadora',
        role: 'operator'
      }
    });
    expect(operatorCreate.statusCode).toBe(201);

    // No token → 401
    const unauthorized = await app.inject({ method: 'GET', url: '/api/users' });
    expect(unauthorized.statusCode).toBe(401);

    // Operator login
    const opLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'op1', password: 'operatorpw' }
    });
    const opToken = opLogin.json().token;

    // Operator tries to access users list → 403
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${opToken}` }
    });
    expect(forbidden.statusCode).toBe(403);

    // Admin can list users
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(allowed.statusCode).toBe(200);
    const users = allowed.json();
    expect(users).toHaveLength(2);
    expect(users.map((u: any) => u.username).sort()).toEqual(['admin', 'op1']);
  });

  test('role policy protects operational endpoints', async () => {
    const adminToken = await setupAdminToken();
    const operatorToken = await createUserAndLogin(adminToken, 'operator');
    const technicianToken = await createUserAndLogin(adminToken, 'technician');

    const unauthenticatedRead = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(unauthenticatedRead.statusCode).toBe(401);

    const technicianRead = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { authorization: `Bearer ${technicianToken}` }
    });
    expect(technicianRead.statusCode).toBe(200);

    const technicianClientWrite = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { authorization: `Bearer ${technicianToken}` },
      payload: { fullName: 'Cliente Tecnico' }
    });
    expect(technicianClientWrite.statusCode).toBe(403);

    const operatorClientWrite = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { fullName: 'Cliente Operadora' }
    });
    expect(operatorClientWrite.statusCode).toBe(201);

    const technicianPayments = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${technicianToken}` }
    });
    expect(technicianPayments.statusCode).toBe(403);

    const technicianWorkOrder = await app.inject({
      method: 'POST',
      url: '/api/work-orders',
      headers: { authorization: `Bearer ${technicianToken}` },
      payload: { title: 'Visita tecnica', priority: 'media' }
    });
    expect(technicianWorkOrder.statusCode).toBe(201);
  });

  test('topology read routes require authentication and accept every authenticated role', async () => {
    const adminToken = await setupAdminToken();
    const operatorToken = await createUserAndLogin(adminToken, 'operator');
    const technicianToken = await createUserAndLogin(adminToken, 'technician');
    const routes = [
      '/api/topology',
      '/api/topology/backbones/1/clients',
      '/api/topology/search?q=core'
    ];
    const tokens = [adminToken, operatorToken, technicianToken];

    for (const url of routes) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      for (const token of tokens) {
        const authenticated = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` }
        });
        expect(authenticated.statusCode).not.toBe(401);
      }
    }
  });

  test('cannot deactivate last active admin', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' }
    });
    const adminToken = setup.json().token;
    const adminId = setup.json().user.id;

    const deactivate = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { active: false }
    });
    expect(deactivate.statusCode).toBe(400);

    const stillAdmin = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(stillAdmin.statusCode).toBe(200);
    expect(stillAdmin.json().user.role).toBe('admin');
  });

  test('admin can reset a user password and audit logs record critical actions', async () => {
    const adminToken = await setupAdminToken();
    const userCreate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username: 'op-reset',
        password: 'oldpassword',
        fullName: 'Operadora Reset',
        role: 'operator'
      }
    });
    expect(userCreate.statusCode).toBe(201);
    const userId = userCreate.json().id;

    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${userId}/reset-password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { password: 'newpassword' }
    });
    expect(reset.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'op-reset', password: 'oldpassword' }
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'op-reset', password: 'newpassword' }
    });
    expect(newLogin.statusCode).toBe(200);

    const operatorLogs = await app.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: { authorization: `Bearer ${newLogin.json().token}` }
    });
    expect(operatorLogs.statusCode).toBe(403);

    const logs = await app.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(logs.statusCode).toBe(200);
    const actions = logs.json().rows.map((row: any) => row.action);
    expect(actions).toContain('create');
    expect(actions).toContain('reset_password');
  });

  test('locks the account after repeated failures and rejects even the correct password', async () => {
    await setupAdminToken();

    // Five wrong passwords. Each is a 401; the fifth arms the lockout.
    for (let i = 0; i < 5; i++) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' }
      });
      expect(bad.statusCode).toBe(401);
    }

    // Now locked: the correct password is refused with 429 + Retry-After.
    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'supersecret' }
    });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.json().retryAfterSeconds).toBeGreaterThan(0);

    // The throttle is auditable: failures and the lockout are recorded.
    const actions = (db
      .prepare('SELECT action FROM audit_logs')
      .all() as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain('login_failed');
    expect(actions).toContain('login_locked');
  });

  test('a successful login clears the failure counter and is audited', async () => {
    await setupAdminToken();

    // A few failures, but below the lockout threshold.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' }
      });
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM login_throttle').get() as { n: number }).n).toBeGreaterThan(0);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'supersecret' }
    });
    expect(ok.statusCode).toBe(200);

    // Counter reset → table emptied for these identifiers.
    expect((db.prepare('SELECT COUNT(*) AS n FROM login_throttle').get() as { n: number }).n).toBe(0);

    // The success is recorded for the audit trail.
    const success = db
      .prepare(`SELECT action FROM audit_logs WHERE action = 'login_success'`)
      .get() as { action: string } | undefined;
    expect(success?.action).toBe('login_success');

    // And the cleared counter tolerates more failures without an immediate lock.
    const afterReset = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' }
    });
    expect(afterReset.statusCode).toBe(401);
  });

  test('admin can page and filter audit logs by date', async () => {
    const adminToken = await setupAdminToken();
    const insert = db.prepare(`
      INSERT INTO audit_logs (action, entity_type, entity_id, summary, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('create', 'clients', '1', 'Cliente criado', '2026-05-01 09:00:00');
    insert.run('update', 'clients', '1', 'Cliente atualizado', '2026-05-02 10:00:00');
    insert.run('delete', 'plans', '2', 'Plano removido', '2026-05-03 11:00:00');

    const page = await app.inject({
      method: 'GET',
      url: '/api/audit-logs?page=1&pageSize=1&dateFrom=2026-05-01&dateTo=2026-05-02&entityType=clients',
      headers: { authorization: `Bearer ${adminToken}` }
    });

    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      entities: expect.arrayContaining(['clients', 'plans'])
    });
    expect(page.json().rows).toHaveLength(1);
    expect(page.json().rows[0].summary).toBe('Cliente atualizado');
  });
});
