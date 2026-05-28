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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-tech-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.exec(`
    DELETE FROM whatsapp_notices;
    DELETE FROM service_events;
    DELETE FROM service_device_assignments;
    DELETE FROM payments;
    DELETE FROM stock_movements;
    DELETE FROM services;
    DELETE FROM internet_plans;
    DELETE FROM equipment_catalog;
    DELETE FROM app_settings;
    DELETE FROM clients;
    DELETE FROM users;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

function seedBaseService() {
  const client = db.prepare(`
    INSERT INTO clients (client_code, full_name, status)
    VALUES ('CLT-T001', 'Cliente Tec', 'active')
  `).run();
  const plan = db.prepare(`
    INSERT INTO internet_plans (
      name, download_speed, upload_speed, connection_type, monthly_price_cve
    )
    VALUES ('Plano Tec', '50 Mbps', '20 Mbps', 'fibra', 3500)
  `).run();
  const catalog = db.prepare(`
    INSERT INTO equipment_catalog (
      type, brand, model, purchase_price_cve, selling_price_cve, stock_total, active
    )
    VALUES ('router', 'Teste', 'Router Tec', 1000, 1500, 10, 1)
  `).run();
  const user = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, active)
    VALUES ('tec1', 'hash', 'technician', 'Tecnico 1', 1)
  `).run();
  const service = db.prepare(`
    INSERT INTO services (
      client_id, plan_id, monthly_value_cve, activation_date, due_day, status
    )
    VALUES (?, ?, 3500, '2026-01-15', 10, 'active')
  `).run(client.lastInsertRowid, plan.lastInsertRowid);

  return { client, plan, catalog, user, service };
}

describe('technical routes', () => {
  test('creates a device assignment and records the installation event', async () => {
    const { catalog, service, user } = seedBaseService();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/device-assignments`,
      payload: {
        catalogId: catalog.lastInsertRowid,
        serialNumber: 'SN-001',
        assetTag: 'AST-001',
        ipAddress: '192.168.1.10',
        macAddress: 'AA:BB:CC:DD:EE:FF',
        technicianId: user.lastInsertRowid,
        notes: 'Instalacao inicial'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      assignmentId: expect.any(Number),
      eventId: expect.any(Number)
    });

    const history = await app.inject({
      method: 'GET',
      url: `/api/services/${service.lastInsertRowid}/technical-history`
    });

    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      assignments: Array<{ serialNumber: string; assetTag: string; endDate: string | null }>;
      events: Array<{ eventType: string; notes: string | null }>;
    };
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({
      serialNumber: 'SN-001',
      assetTag: 'AST-001',
      endDate: null
    });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      eventType: 'instalacao',
      notes: 'Instalacao inicial'
    });
  });

  test('replaces an active assignment in one transaction', async () => {
    const { catalog, service, user } = seedBaseService();
    const first = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/device-assignments`,
      payload: {
        catalogId: catalog.lastInsertRowid,
        serialNumber: 'SN-OLD',
        assetTag: 'AST-OLD',
        technicianId: user.lastInsertRowid,
        notes: 'Primeira instalacao'
      }
    });

    const assignmentId = (first.json() as { assignmentId: number }).assignmentId;

    const replacement = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/replace`,
      payload: {
        catalogId: catalog.lastInsertRowid,
        serialNumber: 'SN-NEW',
        assetTag: 'AST-NEW',
        technicianId: user.lastInsertRowid,
        notes: 'Troca por avaria'
      }
    });

    expect(replacement.statusCode).toBe(201);
    expect(replacement.json()).toMatchObject({
      assignmentId: expect.any(Number),
      eventId: expect.any(Number)
    });

    const assignments = db.prepare(`
      SELECT serial_number AS serialNumber, asset_tag AS assetTag, end_date AS endDate
      FROM service_device_assignments
      WHERE service_id = ?
      ORDER BY id
    `).all(service.lastInsertRowid) as Array<{ serialNumber: string; assetTag: string; endDate: string | null }>;

    expect(assignments).toHaveLength(2);
    expect(assignments[0].endDate).not.toBeNull();
    expect(assignments[1]).toMatchObject({
      serialNumber: 'SN-NEW',
      assetTag: 'AST-NEW',
      endDate: null
    });

    const events = db.prepare(`
      SELECT event_type AS eventType, notes
      FROM service_events
      WHERE service_id = ?
      ORDER BY id
    `).all(service.lastInsertRowid) as Array<{ eventType: string; notes: string | null }>;

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      eventType: 'troca_equipamento',
      notes: 'Troca por avaria'
    });
  });

  test('rejects duplicate active serial numbers', async () => {
    const { catalog, service } = seedBaseService();
    const first = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/device-assignments`,
      payload: {
        catalogId: catalog.lastInsertRowid,
        serialNumber: 'SN-DUP'
      }
    });

    expect(first.statusCode).toBe(201);

    const clientId = (db.prepare('SELECT id FROM clients LIMIT 1').get() as { id: number }).id;
    const planId = (db.prepare('SELECT id FROM internet_plans LIMIT 1').get() as { id: number }).id;
    const secondService = db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, ?, 3500, '2026-01-15', 10, 'active')
    `).run(clientId, planId);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/services/${secondService.lastInsertRowid}/device-assignments`,
      payload: {
        catalogId: catalog.lastInsertRowid,
        serialNumber: 'SN-DUP'
      }
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'Serial ja esta atribuido a outro equipamento ativo' });
  });
});
