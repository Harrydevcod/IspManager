import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { BackboneConflictError, createBackbone, updateBackbone } from './backbone-management';
import { checkDeviceIdentity, checkSoldSerialIdentity, installDeviceWithinTx, preflightItems } from './serviceInstall';

let db: Database.Database;
afterEach(() => db?.close());
function fixture() {
  db = new Database(':memory:');
  runMigrations(db);
  const clientId = Number(db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('SERIAL', 'Cliente real')").run().lastInsertRowid);
  const serviceId = Number(db.prepare("INSERT INTO services (client_id, monthly_value_cve) VALUES (?, 2500)").run(clientId).lastInsertRowid);
  const catalogId = Number(db.prepare("INSERT INTO equipment_catalog (category, type, model, is_serialized, stock_total) VALUES ('equipamento', 'router', 'Router', 1, 5)").run().lastInsertRowid);
  const paymentId = Number(db.prepare("INSERT INTO payments (client_id, reference_month, amount_cve, due_date, document_type, status) VALUES (?, 'AVULSA-serial', 500, '2026-10-01', 'sale_ticket', 'paid')").run(clientId).lastInsertRowid);
  const lineId = Number(db.prepare("INSERT INTO payment_lines (payment_id, kind, description, amount_cve) VALUES (?, 'avulso', 'Router vendido', 500)").run(paymentId).lastInsertRowid);
  db.prepare('INSERT INTO sale_ticket_lines (payment_line_id, catalog_id, quantity, unit_price_cve) VALUES (?, ?, 1, 500)').run(lineId, catalogId);
  db.prepare("INSERT INTO sale_ticket_serials (payment_line_id, serial_number, normalized_serial) VALUES (?, 'Sold-001', 'SOLD-001')").run(lineId);
  return { serviceId, catalogId };
}

function backbone(catalogId: number, serialNumber: string) {
  return { catalogId, name: 'Core', status: 'active' as const, serialNumber, assetTag: null,
    ipAddress: null, macAddress: null, wanMode: null, operationMode: null, routerInterface: null,
    island: null, zone: null, notes: null, upstreamDeviceIds: [] as number[] };
}

describe('sold serial identity', () => {
  test.each(['Sold-001', ' sold-001 ', 'SOLD-001'])('blocks sold serial %s through every installation gate', (serialNumber) => {
    const { serviceId, catalogId } = fixture();
    expect(checkDeviceIdentity(db, { serialNumber })).toMatchObject({ status: 409 });
    expect(preflightItems(db, [{ catalogId, serialNumber }])).toMatchObject({ ok: false, status: 409 });
    expect(() => db.transaction(() => installDeviceWithinTx(db, {
      serviceId, clientName: 'Cliente real', device: { catalogId, serialNumber }, userId: null
    }))()).toThrow('device_identity:409');
    expect(db.prepare('SELECT stock_total AS stock FROM equipment_catalog WHERE id = ?').get(catalogId)).toEqual({ stock: 5 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_device_assignments').get()).toEqual({ n: 0 });
  });

  test('blocks backbone creation and serial edits without stock or identity changes', () => {
    const { catalogId } = fixture();
    expect(() => createBackbone(db, backbone(catalogId, ' sold-001 '), null)).toThrow(BackboneConflictError);
    const created = createBackbone(db, backbone(catalogId, 'NEW-001'), null);
    expect(() => updateBackbone(db, created.id, backbone(catalogId, 'SoLd-001'), null)).toThrow(BackboneConflictError);
    expect(db.prepare('SELECT serial_number AS serialNumber FROM backbone_devices WHERE id = ?').get(created.id)).toEqual({ serialNumber: 'NEW-001' });
    expect(db.prepare('SELECT stock_total AS stock FROM equipment_catalog WHERE id = ?').get(catalogId)).toEqual({ stock: 4 });
  });

  test('releases the serial after cancellation and still checks other active assignments', () => {
    const { catalogId, serviceId } = fixture();
    db.prepare("UPDATE sale_ticket_serials SET released_at = datetime('now')").run();
    expect(checkSoldSerialIdentity(db, ' sold-001 ')).toBeNull();
    expect(preflightItems(db, [{ catalogId, serialNumber: 'sold-001' }])).toEqual({ ok: true });
    db.transaction(() => installDeviceWithinTx(db, {
      serviceId, clientName: 'Cliente real', device: { catalogId, serialNumber: 'sold-001' }, userId: null
    }))();
    expect(checkDeviceIdentity(db, { serialNumber: ' SOLD-001 ' })).toMatchObject({ status: 409 });
  });

  test('rejects mixed-case duplicate serials in one install batch', () => {
    const { catalogId } = fixture();
    expect(preflightItems(db, [{ catalogId, serialNumber: 'New-002' }, { catalogId, serialNumber: ' new-002 ' }]))
      .toMatchObject({ ok: false, status: 409 });
  });
});
