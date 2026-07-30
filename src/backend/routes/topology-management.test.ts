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
  'backbone_assignment_links',
  'backbone_devices',
  'service_device_shares',
  'service_device_assignments',
  'stock_movements',
  'services',
  'internet_plans',
  'equipment_catalog',
  'clients',
  'audit_logs'
];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-topology-management-test-'));
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

function insertCatalog(model = 'Rocket Prism 5AC', stockTotal = 7): number {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, stock_total)
    VALUES ('equipamento', 'antena', 'Ubiquiti', ?, ?)
  `).run(model, stockTotal).lastInsertRowid);
}

function insertActiveAssignment(catalogId: number): number {
  const clientId = Number(db.prepare(`
    INSERT INTO clients (client_code, full_name) VALUES ('CLI-001', 'Cliente de teste')
  `).run().lastInsertRowid);
  const planId = Number(db.prepare(`
    INSERT INTO internet_plans (name) VALUES ('Plano de teste')
  `).run().lastInsertRowid);
  const serviceId = Number(db.prepare(`
    INSERT INTO services (client_id, plan_id) VALUES (?, ?)
  `).run(clientId, planId).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, serial_number)
    VALUES (?, ?, 'CPE-001')
  `).run(serviceId, catalogId).lastInsertRowid);
}

function validBackbone(catalogId: number, name = 'Monte Verde'): Record<string, unknown> {
  return {
    catalogId,
    name,
    status: 'active',
    serialNumber: 'BB-001',
    assetTag: 'AT-001',
    ipAddress: '10.10.0.1',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    island: 'Sao Vicente',
    zone: 'Monte Verde',
    notes: 'Nucleo principal'
  };
}

describe('topology management routes', () => {
  test('creates a physical backbone without changing stock and records a narrow audit event', async () => {
    const catalogId = insertCatalog();
    const beforeStock = db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?').get(catalogId) as { stockTotal: number };
    const beforeMovements = (db.prepare('SELECT COUNT(*) AS total FROM stock_movements').get() as { total: number }).total;

    const response = await app.inject({
      method: 'POST',
      url: '/api/topology/backbones',
      payload: validBackbone(catalogId)
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      catalogId,
      name: 'Monte Verde',
      status: 'active',
      provisional: false,
      macAddress: 'AA:BB:CC:DD:EE:FF'
    });
    expect(db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?').get(catalogId)).toEqual(beforeStock);
    expect((db.prepare('SELECT COUNT(*) AS total FROM stock_movements').get() as { total: number }).total).toBe(beforeMovements);

    const audit = db.prepare(`
      SELECT action, entity_type AS entityType, metadata_json AS metadataJson FROM audit_logs
    `).get() as { action: string; entityType: string; metadataJson: string };
    expect(audit.action).toBe('topology.backbone.create');
    expect(audit.entityType).toBe('backbone_device');
    expect(JSON.parse(audit.metadataJson)).toEqual({
      backboneDeviceId: response.json().id,
      catalogId,
      previousStatus: null,
      nextStatus: 'active',
      previousUpstreamDeviceId: null,
      nextUpstreamDeviceId: null
    });
  });

  test('rolls back a backbone mutation when its mandated audit insert fails', async () => {
    const catalogId = insertCatalog();
    db.exec(`
      CREATE TRIGGER fail_topology_backbone_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'topology.backbone.create'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END
    `);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topology/backbones',
        payload: validBackbone(catalogId)
      });
      expect(response.statusCode).toBe(500);
      expect((db.prepare('SELECT COUNT(*) AS total FROM backbone_devices').get() as { total: number }).total).toBe(0);
    } finally {
      db.exec('DROP TRIGGER fail_topology_backbone_audit');
    }
  });

  test('rejects boolean IDs even when catalog and backbone ID 1 exist', async () => {
    const catalogId = Number(db.prepare(`
      INSERT INTO equipment_catalog (id, category, type, brand, model, stock_total)
      VALUES (1, 'equipamento', 'antena', 'Ubiquiti', 'Rocket Prism 5AC', 7)
    `).run().lastInsertRowid);
    const assignmentId = insertActiveAssignment(catalogId);
    db.prepare(`
      INSERT INTO backbone_devices (id, catalog_id, name, status, provisional)
      VALUES (1, ?, 'Monte Verde', 'active', 0)
    `).run(catalogId);

    expect((await app.inject({
      method: 'POST',
      url: '/api/topology/backbones',
      payload: { ...validBackbone(catalogId), catalogId: true }
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'PUT',
      url: `/api/topology/assignments/${assignmentId}/backbone`,
      payload: { backboneDeviceId: true, reason: null }
    })).statusCode).toBe(400);
  });

  test('lists and validates backbone management input and translates repository errors', async () => {
    const catalogId = insertCatalog();
    const created = await app.inject({ method: 'POST', url: '/api/topology/backbones', payload: validBackbone(catalogId) });
    const backbone = created.json();

    expect((await app.inject({ method: 'GET', url: '/api/topology/backbones?page=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/topology/backbones/invalid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/topology/backbones/999999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/topology/backbones' })).json()).toMatchObject({ total: 1, items: [expect.objectContaining({ id: backbone.id })] });

    expect((await app.inject({ method: 'POST', url: '/api/topology/backbones', payload: { catalogId } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/topology/backbones', payload: validBackbone(999999) })).statusCode).toBe(404);
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/topology/backbones/${backbone.id}`,
      payload: { ...validBackbone(catalogId), status: 'maintenance', expectedUpdatedAt: backbone.updatedAt }
    });
    expect(updated.statusCode).toBe(200);
    const updateAudit = db.prepare(`
      SELECT metadata_json AS metadataJson FROM audit_logs WHERE action = 'topology.backbone.update'
    `).get() as { metadataJson: string };
    expect(JSON.parse(updateAudit.metadataJson)).toEqual({
      backboneDeviceId: backbone.id,
      catalogId,
      previousStatus: 'active',
      nextStatus: 'maintenance',
      previousUpstreamDeviceId: null,
      nextUpstreamDeviceId: null
    });
    expect((await app.inject({
      method: 'PUT',
      url: `/api/topology/backbones/${backbone.id}`,
      payload: { ...validBackbone(catalogId), expectedUpdatedAt: 'stale' }
    })).statusCode).toBe(409);

    const secondCatalogId = insertCatalog('Rocket Prism 5AC backup');
    expect((await app.inject({
      method: 'POST',
      url: '/api/topology/backbones',
      payload: validBackbone(secondCatalogId, 'Segundo nucleo')
    })).statusCode).toBe(409);
  });

  test('links, transfers, and unlinks an active assignment with audit history', async () => {
    const cpeCatalogId = insertCatalog('LiteBeam 5AC');
    const assignmentId = insertActiveAssignment(cpeCatalogId);
    const firstCatalogId = insertCatalog('Rocket Prism A');
    const secondCatalogId = insertCatalog('Rocket Prism B');
    const first = (await app.inject({ method: 'POST', url: '/api/topology/backbones', payload: validBackbone(firstCatalogId, 'Nucleo A') })).json();
    const second = (await app.inject({
      method: 'POST',
      url: '/api/topology/backbones',
      payload: { ...validBackbone(secondCatalogId, 'Nucleo B'), serialNumber: 'BB-002', assetTag: 'AT-002' }
    })).json();
    db.prepare('DELETE FROM audit_logs').run();

    expect((await app.inject({
      method: 'PUT', url: `/api/topology/assignments/${assignmentId}/backbone`,
      payload: { backboneDeviceId: first.id, reason: 'Ligacao inicial' }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'PUT', url: `/api/topology/assignments/${assignmentId}/backbone`,
      payload: { backboneDeviceId: second.id, reason: 'Transferencia operacional' }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'DELETE', url: `/api/topology/assignments/${assignmentId}/backbone`,
      payload: { reason: 'Desativacao planeada' }
    })).statusCode).toBe(200);

    const audits = db.prepare(`
      SELECT action, metadata_json AS metadataJson FROM audit_logs ORDER BY id
    `).all() as Array<{ action: string; metadataJson: string }>;
    expect(audits.map((entry) => entry.action)).toEqual([
      'topology.assignment.link',
      'topology.assignment.transfer',
      'topology.assignment.unlink'
    ]);
    expect(audits.map((entry) => JSON.parse(entry.metadataJson))).toEqual([
      { assignmentId, previousBackboneDeviceId: null, nextBackboneDeviceId: first.id },
      { assignmentId, previousBackboneDeviceId: first.id, nextBackboneDeviceId: second.id },
      { assignmentId, previousBackboneDeviceId: second.id, nextBackboneDeviceId: null }
    ]);

    expect((await app.inject({
      method: 'PUT', url: '/api/topology/assignments/not-an-id/backbone',
      payload: { backboneDeviceId: first.id, reason: null }
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'PUT', url: `/api/topology/assignments/${assignmentId}/backbone`,
      payload: { backboneDeviceId: 999999, reason: null }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'PUT', url: '/api/topology/assignments/999999/backbone',
      payload: { backboneDeviceId: first.id, reason: null }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'DELETE', url: `/api/topology/assignments/${assignmentId}/backbone`, payload: { reason: null }
    })).statusCode).toBe(404);
  });
});
