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

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-wo-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
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
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

function seedService() {
  const client = db.prepare(`
    INSERT INTO clients (client_code, full_name, status)
    VALUES ('CLT-WO1', 'Cliente OS', 'active')
  `).run();
  const plan = db.prepare(`
    INSERT INTO internet_plans (name, download_speed, upload_speed, connection_type, monthly_price_centavos)
    VALUES ('Plano OS', '100', '50', 'fibra', 500000)
  `).run();
  const service = db.prepare(`
    INSERT INTO services (client_id, plan_id, monthly_value_centavos, activation_date, due_day, status)
    VALUES (?, ?, 500000, '2026-01-15', 10, 'active')
  `).run(client.lastInsertRowid, plan.lastInsertRowid);
  return { clientId: Number(client.lastInsertRowid), serviceId: Number(service.lastInsertRowid) };
}

describe('work-orders routes', () => {
  test('creates an OS in aguarda by default and returns enriched payload', async () => {
    const { serviceId } = seedService();

    const response = await app.inject({
      method: 'POST',
      url: '/api/work-orders',
      payload: { serviceId, title: 'Instalacao inicial', priority: 'alta' }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('aguarda');
    expect(body.priority).toBe('alta');
    expect(body.title).toBe('Instalacao inicial');
    expect(body.clientName).toBe('Cliente OS');
    expect(body.planName).toBe('Plano OS');
    expect(body.startedAt).toBeNull();
    expect(body.completedAt).toBeNull();
  });

  test('PATCH to em_curso stamps started_at; to concluida creates service_event', async () => {
    const { serviceId } = seedService();

    const created = await app.inject({
      method: 'POST',
      url: '/api/work-orders',
      payload: {
        serviceId,
        title: 'Manutencao mensal',
        eventType: 'manutencao'
      }
    });
    const id = created.json().id;

    const start = await app.inject({
      method: 'PATCH',
      url: `/api/work-orders/${id}`,
      payload: { status: 'em_curso' }
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().status).toBe('em_curso');
    expect(start.json().startedAt).not.toBeNull();
    expect(start.json().completedAt).toBeNull();

    const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM service_events').get() as { n: number };
    expect(eventsBefore.n).toBe(0);

    const done = await app.inject({
      method: 'PATCH',
      url: `/api/work-orders/${id}`,
      payload: { status: 'concluida', completionNotes: 'tudo OK' }
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('concluida');
    expect(done.json().completedAt).not.toBeNull();

    const events = db.prepare(`
      SELECT event_type AS eventType, notes FROM service_events WHERE service_id = ?
    `).all(serviceId) as Array<{ eventType: string; notes: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('manutencao');
    expect(events[0].notes).toContain('Manutencao mensal');
    expect(events[0].notes).toContain('tudo OK');
  });

  test('GET /board groups by status and reports open count', async () => {
    const { serviceId } = seedService();

    for (const status of ['aguarda', 'aguarda', 'em_curso', 'concluida', 'cancelada'] as const) {
      await app.inject({
        method: 'POST',
        url: '/api/work-orders',
        payload: { serviceId, title: `OS ${status}`, status }
      });
    }

    const board = await app.inject({ method: 'GET', url: '/api/work-orders/board' });
    expect(board.statusCode).toBe(200);
    const body = board.json();
    expect(body.columns).toHaveLength(5);
    const byStatus = Object.fromEntries(body.columns.map((c: any) => [c.status, c.items.length]));
    expect(byStatus.aguarda).toBe(2);
    expect(byStatus.em_curso).toBe(1);
    expect(byStatus.concluida).toBe(1);
    expect(byStatus.cancelada).toBe(1);
    expect(body.totals.open).toBe(3);
    expect(body.totals.total).toBe(5);
  });
});
