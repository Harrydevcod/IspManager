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
    DELETE FROM service_install_costs;
    DELETE FROM service_material_lines;
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
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-001',
          assetTag: 'AST-001',
          ipAddress: '192.168.1.10',
          macAddress: 'AA:BB:CC:DD:EE:FF',
          technicianId: user.lastInsertRowid,
          notes: 'Instalacao inicial'
        }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      assignmentIds: [expect.any(Number)],
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
      notes: 'Instalou 1 equipamento(s) e 0 material(is)'
    });

    expect(db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?')
      .get(catalog.lastInsertRowid)).toEqual({ stockTotal: 9 });
    expect(db.prepare(`
      SELECT type, quantity, unit_cost_cve AS unitCostCve, service_id AS serviceId, client_name AS clientName
      FROM stock_movements
      WHERE catalog_id = ?
    `).get(catalog.lastInsertRowid)).toEqual({
      type: 'saida',
      quantity: 1,
      unitCostCve: 1000,
      serviceId: service.lastInsertRowid,
      clientName: 'Cliente Tec'
    });
  });

  test('replaces an active assignment in one transaction', async () => {
    const { catalog, service, user } = seedBaseService();
    const first = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-OLD',
          assetTag: 'AST-OLD',
          technicianId: user.lastInsertRowid,
          notes: 'Primeira instalacao'
        }]
      }
    });

    const assignmentId = (first.json() as { assignmentIds: number[] }).assignmentIds[0];

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
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-DUP'
        }]
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
      url: `/api/services/${secondService.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-DUP'
        }]
      }
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'Serial ja esta atribuido a outro equipamento ativo' });
  });

  test('rejects assignment when stock is not available', async () => {
    const { catalog, service } = seedBaseService();
    db.prepare('UPDATE equipment_catalog SET stock_total = 0 WHERE id = ?').run(catalog.lastInsertRowid);

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-NOSTOCK'
        }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 0' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_device_assignments').get()).toEqual({ n: 0 });
  });

  test('installs a batch of items (device + material) on an existing service', async () => {
    const { catalog, service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','UTP','metro',0,80,100,1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [
          { catalogId: catalog.lastInsertRowid, serialNumber: 'SN-B1' },
          { catalogId: cable.lastInsertRowid, quantity: 25 }
        ]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { assignmentIds: number[]; materialLineIds: number[]; eventId: number };
    expect(body.assignmentIds).toHaveLength(1);
    expect(body.materialLineIds).toHaveLength(1);
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(catalog.lastInsertRowid)).toEqual({ s: 9 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 75 });
    expect(db.prepare("SELECT count(*) AS n FROM service_events WHERE service_id = ? AND event_type='instalacao'").get(service.lastInsertRowid)).toEqual({ n: 1 });
  });

  test('rejects the batch when material stock is insufficient (no side effects)', async () => {
    const { service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total, active)
      VALUES ('material','cabo','UTP','metro',0,5,1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [{ catalogId: cable.lastInsertRowid, quantity: 10 }] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 5' });
    expect(db.prepare('SELECT count(*) AS n FROM service_material_lines').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 5 });
  });

  test('technical-history returns materials alongside assignments', async () => {
    const { service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','Cabo UTP','metro',0,80,100,1)
    `).run();
    await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [{ catalogId: cable.lastInsertRowid, quantity: 20 }] }
    });

    const history = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    const body = history.json() as { materials: Array<{ model: string; quantity: number; unitOfMeasure: string }> };
    expect(body.materials).toHaveLength(1);
    expect(body.materials[0]).toMatchObject({ model: 'Cabo UTP', quantity: 20, unitOfMeasure: 'metro' });
  });

  test('adds installation labour cost via /items (no items needed)', async () => {
    const { service } = seedBaseService();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { installCosts: [{ kind: 'mao_de_obra', amountCve: 1800 }] }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { installCostIds: number[] };
    expect(body.installCostIds).toHaveLength(1);

    const history = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    const hist = history.json() as { installCosts: Array<{ kind: string; amountCve: number }> };
    expect(hist.installCosts).toHaveLength(1);
    expect(hist.installCosts[0]).toMatchObject({ kind: 'mao_de_obra', amountCve: 1800 });
  });
});
