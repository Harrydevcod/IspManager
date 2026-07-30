import { afterEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  BackboneConflictError,
  BackboneValidationError,
  clearAssignmentBackbone,
  createBackbone,
  getBackbone,
  listAssignments,
  listBackbones,
  setAssignmentBackbone,
  updateBackbone
} from './backbone-management';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seed(db: Database.Database) {
  const actor = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name)
    VALUES ('operator', 'hash', 'operator', 'Operador')
  `).run();
  const catalog = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'antena', 'Ubiquiti', 'Rocket Prism', 1, 10000, 10, 1)
  `).run();
  const otherCatalog = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'cpe', 'Ubiquiti', 'LiteBeam', 1, 3000, 10, 1)
  `).run();
  const client = db.prepare(`
    INSERT INTO clients (client_code, full_name, island, zone, status)
    VALUES ('CLT-001', 'Ana Silva', 'Santiago', 'Praia', 'active')
  `).run();
  const service = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, 3500, 10, 'active')
  `).run(client.lastInsertRowid);
  const activeAssignment = db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, serial_number, asset_tag, ip_address, mac_address)
    VALUES (?, ?, ' CPE-01 ', ' ASSET-01 ', '10.0.0.10', 'aa:bb:cc:dd:ee:01')
  `).run(service.lastInsertRowid, otherCatalog.lastInsertRowid);
  const inactiveAssignment = db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, end_date)
    VALUES (?, ?, date('now'))
  `).run(service.lastInsertRowid, otherCatalog.lastInsertRowid);
  return {
    catalogId: Number(catalog.lastInsertRowid),
    otherCatalogId: Number(otherCatalog.lastInsertRowid),
    actorId: Number(actor.lastInsertRowid),
    activeAssignmentId: Number(activeAssignment.lastInsertRowid),
    inactiveAssignmentId: Number(inactiveAssignment.lastInsertRowid)
  };
}

function input(catalogId: number, overrides: Record<string, unknown> = {}) {
  return {
    catalogId,
    name: '  Core Norte  ',
    status: 'active' as const,
    serialNumber: ' SN-001 ',
    assetTag: ' AT-001 ',
    ipAddress: ' 10.0.0.1 ',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    island: ' Santiago ',
    zone: ' Praia ',
    notes: '  Torre principal ',
    ...overrides
  };
}

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe('backbone management repository', () => {
  test('normalizes identity fields and returns a complete backbone detail', () => {
    db = freshDb();
    const fixture = seed(db);

    const created = createBackbone(db, input(fixture.catalogId), null);

    expect(created).toMatchObject({
      name: 'Core Norte', serialNumber: 'SN-001', assetTag: 'AT-001',
      ipAddress: '10.0.0.1', macAddress: 'AA:BB:CC:DD:EE:FF',
      island: 'Santiago', zone: 'Praia', notes: 'Torre principal',
      provisional: false, linkedAssignmentCount: 0, assignments: []
    });
    expect(getBackbone(db, created.id)).toEqual(created);
  });

  test('paginates and filters normalized backbone search results', () => {
    db = freshDb();
    const fixture = seed(db);
    createBackbone(db, input(fixture.catalogId, { name: 'Core Sul', serialNumber: null, assetTag: null }), null);
    createBackbone(db, input(fixture.catalogId, { name: 'Core Norte', serialNumber: 'SERIAL-NORTE', status: 'maintenance' }), null);

    const page = listBackbones(db, { query: '  serial-norte ', status: 'maintenance', page: 9, pageSize: 999 });

    expect(page).toMatchObject({ page: 1, pageSize: 100, total: 1, totalPages: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ name: 'Core Norte', status: 'maintenance' });
  });

  test('lists only active unlinked assignments and searches their factual context', () => {
    db = freshDb();
    const fixture = seed(db);
    const backbone = createBackbone(db, input(fixture.catalogId), null);

    const all = listAssignments(db, { mapping: 'unlinked', query: ' ana silva ', page: 1, pageSize: 25 });
    expect(all.items).toEqual([expect.objectContaining({
      id: fixture.activeAssignmentId, clientCode: 'CLT-001', clientName: 'Ana Silva', backboneDeviceId: null
    })]);

    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: backbone.id, reason: null }, null);
    expect(listAssignments(db, { mapping: 'unlinked', page: 1, pageSize: 25 }).items).toEqual([]);
    expect(listAssignments(db, { mapping: 'linked', backboneDeviceId: backbone.id, page: 1, pageSize: 25 }).items)
      .toEqual([expect.objectContaining({ id: fixture.activeAssignmentId, backboneDeviceId: backbone.id })]);
    expect(() => setAssignmentBackbone(db!, fixture.inactiveAssignmentId, { backboneDeviceId: backbone.id, reason: null }, null))
      .toThrow(BackboneValidationError);
  });

  test('updates optimistically and rejects stale or retired-with-links changes', () => {
    db = freshDb();
    const fixture = seed(db);
    expect(() => createBackbone(db!, input(fixture.catalogId, { status: 'invalid-status' }), null))
      .toThrow(BackboneValidationError);
    const created = createBackbone(db, input(fixture.catalogId), null);
    const updated = updateBackbone(db, created.id, input(fixture.catalogId, {
      name: 'Core Atualizado', expectedUpdatedAt: created.updatedAt
    }), null);

    expect(updated.name).toBe('Core Atualizado');
    expect(() => updateBackbone(db!, created.id, input(fixture.catalogId, {
      name: 'Versão antiga', expectedUpdatedAt: created.updatedAt
    }), null)).toThrow(BackboneConflictError);

    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: created.id, reason: null }, null);
    expect(() => updateBackbone(db!, created.id, input(fixture.catalogId, { status: 'retired' }), null))
      .toThrow(BackboneValidationError);
  });

  test('transfers and clears an assignment atomically while retaining link history', () => {
    db = freshDb();
    const fixture = seed(db);
    const first = createBackbone(db, input(fixture.catalogId, { name: 'Core A' }), null);
    const second = createBackbone(db, input(fixture.catalogId, { name: 'Core B', serialNumber: 'SN-002', assetTag: 'AT-002' }), null);

    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: first.id, reason: 'Instalação' }, fixture.actorId);
    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: second.id, reason: 'Transferência' }, fixture.actorId);

    expect(db.prepare(`
      SELECT backbone_device_id AS backboneDeviceId, ended_at AS endedAt, ended_by AS endedBy, change_reason AS reason
      FROM backbone_assignment_links WHERE assignment_id = ? ORDER BY id
    `).all(fixture.activeAssignmentId)).toEqual([
      expect.objectContaining({ backboneDeviceId: first.id, endedAt: expect.any(String), endedBy: fixture.actorId, reason: 'Transferência' }),
      expect.objectContaining({ backboneDeviceId: second.id, endedAt: null, endedBy: null, reason: 'Transferência' })
    ]);

    clearAssignmentBackbone(db, fixture.activeAssignmentId, ' Retirado ', fixture.actorId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM backbone_assignment_links WHERE assignment_id = ? AND ended_at IS NULL').get(fixture.activeAssignmentId))
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT ended_by AS endedBy, change_reason AS reason FROM backbone_assignment_links WHERE assignment_id = ? ORDER BY id DESC LIMIT 1').get(fixture.activeAssignmentId))
      .toEqual({ endedBy: fixture.actorId, reason: 'Retirado' });
  });

  test('keeps the current active link when a transfer insert is rejected', () => {
    db = freshDb();
    const fixture = seed(db);
    const first = createBackbone(db, input(fixture.catalogId, { name: 'Core A' }), null);
    const blocked = createBackbone(db, input(fixture.catalogId, {
      name: 'Core Bloqueado', serialNumber: 'SN-002', assetTag: 'AT-002'
    }), null);
    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: first.id, reason: null }, fixture.actorId);
    db.exec(`
      CREATE TRIGGER reject_blocked_backbone_link
      BEFORE INSERT ON backbone_assignment_links
      WHEN NEW.backbone_device_id = ${blocked.id}
      BEGIN
        SELECT RAISE(ABORT, 'blocked transfer insert');
      END;
    `);

    expect(() => setAssignmentBackbone(db!, fixture.activeAssignmentId, {
      backboneDeviceId: blocked.id, reason: 'Transferência falhada'
    }, fixture.actorId)).toThrow('blocked transfer insert');
    expect(listAssignments(db, {
      mapping: 'linked', backboneDeviceId: first.id, page: 1, pageSize: 25
    }).items).toEqual([expect.objectContaining({ id: fixture.activeAssignmentId, backboneDeviceId: first.id })]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM backbone_assignment_links
      WHERE assignment_id = ? AND ended_at IS NULL
    `).get(fixture.activeAssignmentId)).toEqual({ count: 1 });
  });
});
