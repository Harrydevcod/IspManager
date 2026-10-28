/**
 * Fichas de migração PPPoE: um PDF com as senhas em claro. Auth a sério, como na
 * revelação de uma senha: a regra que se testa é quem chega a elas.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { writePppoeSecret } from '../lib/secrets';
import { loadMigrationCards, pppoeTarget, type MigrationDevice } from '../lib/pppoe-migration-cards';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let resetAuthSecretCache: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-migration-cards-'));
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
  db.prepare('DELETE FROM service_network_state').run();
  db.prepare('DELETE FROM service_device_assignments').run();
  db.prepare('DELETE FROM equipment_catalog').run();
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
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' } });
  expect(setup.statusCode).toBe(201);
  return setup.json().token as string;
}

async function operatorToken(admin: string) {
  await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${admin}` },
    payload: { username: 'op', password: 'operator-pw-1', fullName: 'Op', role: 'operator' } });
  return (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'op', password: 'operator-pw-1' } })).json().token as string;
}

const SENHA = 'senha-da-ficha';

function seed(name: string, opts: { online?: boolean; password?: boolean; status?: string } = {}): number {
  const clientId = Number(db.prepare(`INSERT INTO clients (client_code, full_name, status, zone) VALUES (?, ?, 'active', 'Zona')`)
    .run(`C-${name}`, name).lastInsertRowid);
  const id = Number(db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status, pppoe_username) VALUES (?, 250000, 1, ?, ?)`)
    .run(clientId, opts.status ?? 'active', name.toLowerCase()).lastInsertRowid);
  if (opts.password !== false) writePppoeSecret(db, id, `${SENHA}-${name}`);
  if (opts.online) db.prepare(`INSERT INTO service_network_state (service_id, last_online_at) VALUES (?, datetime('now'))`).run(id);
  return id;
}

const cards = (token: string, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/services/pppoe-migration-cards.pdf', headers: { authorization: `Bearer ${token}` }, payload: body
});

describe('quem leva ficha', () => {
  test('por migrar: só os activos nunca vistos por PPPoE; todos: também os já migrados; sem senha fica de fora', () => {
    const pending = seed('Ana');
    const migrated = seed('Bruno', { online: true });
    const noPassword = seed('Carla', { password: false });
    seed('Duarte', { status: 'cancelled' });

    const catalogId = Number(db.prepare(`INSERT INTO equipment_catalog (type, brand, model, stock_total, active) VALUES ('cpe', 'TP-Link', 'CPE510', 5, 1)`).run().lastInsertRowid);
    db.prepare(`INSERT INTO service_device_assignments (service_id, catalog_id, start_date, mac_address, operation_mode) VALUES (?, ?, '2026-01-01', 'AA:BB:CC:00:11:22', 'router')`)
      .run(pending, catalogId);

    const p = loadMigrationCards(db, 'pending');
    expect(p.cards.map((c) => c.serviceId)).toEqual([pending]);
    expect(p.cards[0]).toMatchObject({ username: 'ana', password: `${SENHA}-Ana`, clientName: 'Ana', target: 'Na WAN da antena (TP-Link CPE510)' });
    expect(p.cards[0].devices).toEqual([{ type: 'cpe', name: 'TP-Link CPE510', mac: 'AA:BB:CC:00:11:22', ip: null, mode: 'router' }]);
    expect(p.withoutPassword).toEqual([noPassword]);
    expect(loadMigrationCards(db, 'all').cards.map((c) => c.serviceId)).toEqual([pending, migrated]);
  });

  test('onde configurar: no equipamento que faz NAT; sem regra, confirmar no local', () => {
    const device = (type: string, mode: string | null): MigrationDevice => ({ type, name: type, mac: null, ip: null, mode });
    expect(pppoeTarget([device('cpe', 'router'), device('router', 'router')])).toMatch(/antena/);
    expect(pppoeTarget([device('cpe', 'ponte'), device('router', 'router')])).toMatch(/router do cliente/);
    expect(pppoeTarget([device('cpe', null)])).toMatch(/Confirmar no local/);
    expect(pppoeTarget([device('cpe', 'ponte'), device('router', 'ap')])).toMatch(/Confirmar no local/);
    expect(pppoeTarget([])).toMatch(/Confirmar no local/);
  });
});

describe('POST /api/services/pppoe-migration-cards.pdf', () => {
  test('o admin que confirma a password recebe o PDF, sem cache, e a geração fica auditada sem as senhas', async () => {
    const admin = await adminToken();
    const id = seed('Ana');
    const response = await cards(admin, { password: 'supersecret' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-cards-count']).toBe('1');
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const audit = db.prepare(`SELECT summary, metadata_json AS meta FROM audit_logs WHERE action = 'reveal_pppoe_password_batch'`).all() as Array<{ meta: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].meta).serviceIds).toEqual([id]);
    expect(JSON.stringify(audit)).not.toContain(SENHA);
  });

  test('sem a password, com ela errada, ou com campos a mais, não gera nada', async () => {
    const admin = await adminToken();
    seed('Ana');
    for (const body of [{}, { password: 'errada' }, { password: 'supersecret', extra: 1 }, { password: 'supersecret', scope: 'x' }]) {
      const response = await cards(admin, body);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers['content-type']).not.toBe('application/pdf');
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'reveal_pppoe_password_batch'`).get()).toEqual({ n: 0 });
  });

  test('o operador não chega às fichas, nem com a password dele', async () => {
    const admin = await adminToken();
    seed('Ana');
    expect((await cards(await operatorToken(admin), { password: 'operator-pw-1' })).statusCode).toBe(403);
  });

  test('sem ninguém por migrar ainda sai um PDF de uma página', async () => {
    const admin = await adminToken();
    const response = await cards(admin, { password: 'supersecret' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-cards-count']).toBe('0');
  });
});
