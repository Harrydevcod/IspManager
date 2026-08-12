import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

const TABLES_TO_CLEAR = [
  'network_probe_events',
  'network_probe_state',
  'backbone_devices',
  'equipment_catalog',
  'app_settings'
];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-network-routes-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of TABLES_TO_CLEAR) db.prepare(`DELETE FROM ${table}`).run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

function seedBackbone(name: string, ip: string): number {
  const catalogId = Number(db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, stock_total)
    VALUES ('equipamento', 'antena', 'TP-Link', ?, 3)
  `).run(`Modelo ${name}`).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO backbone_devices (catalog_id, name, ip_address) VALUES (?, ?, ?)
  `).run(catalogId, name, ip).lastInsertRowid);
}

function seedState(targetId: number, ip: string, state: 'up' | 'down') {
  db.prepare(`
    INSERT INTO network_probe_state (target_kind, target_id, ip_address, state, consecutive_fails, last_ok_at, last_change_at, checked_at)
    VALUES ('backbone', ?, ?, ?, 0, datetime('now'), datetime('now','-1 hour'), datetime('now'))
  `).run(targetId, ip, state);
}

describe('GET /api/network/status', () => {
  test('devolve o estado por equipamento e conta os que estão em baixo', async () => {
    const up = seedBackbone('Torre Norte', '10.0.0.1');
    const down = seedBackbone('Torre Sul', '10.0.0.2');
    seedState(up, '10.0.0.1', 'up');
    seedState(down, '10.0.0.2', 'down');

    const response = await app.inject({ method: 'GET', url: '/api/network/status' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.downCount).toBe(1);
    expect(body.enabled).toBe(false);
    expect(body.targets.map((t: { name: string }) => t.name).sort()).toEqual(['Torre Norte', 'Torre Sul']);
  });

  test('um equipamento com IP que a sonda ainda não leu é contado à parte', async () => {
    seedBackbone('Acabado de registar', '10.0.0.3');
    const body = (await app.inject({ method: 'GET', url: '/api/network/status' })).json();
    expect(body.targets).toHaveLength(0);
    expect(body.neverProbed).toBe(1);
  });

  test('recusa uma janela fora do intervalo aceite', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/network/status?days=400' });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/network/targets/:kind/:id/events', () => {
  test('devolve as transições do equipamento pedido', async () => {
    const id = seedBackbone('Torre Norte', '10.0.0.1');
    db.prepare(`
      INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, duration_seconds)
      VALUES ('backbone', ?, '10.0.0.1', 'up', 'down', datetime('now','-2 hours'), 600)
    `).run(id);
    db.prepare(`
      INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, duration_seconds)
      VALUES ('backbone', 999, '10.0.0.9', 'up', 'down', datetime('now','-2 hours'), 600)
    `).run();

    const body = (await app.inject({ method: 'GET', url: `/api/network/targets/backbone/${id}/events` })).json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ toState: 'down', durationSeconds: 600 });
  });

  test('recusa um tipo de alvo desconhecido', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/network/targets/router/1/events' });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/network/probe', () => {
  test('sem equipamentos com IP, responde que saltou em vez de falhar', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/network/probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json().skipped).toBe(true);
  });
});
