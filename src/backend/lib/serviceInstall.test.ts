import { afterEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { installItemsWithinTx, preflightItems } from './serviceInstall';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedService(db: Database.Database) {
  const client = db.prepare(`
    INSERT INTO clients (client_code, full_name, status)
    VALUES ('CLT-BATCH', 'Cliente Batch', 'active')
  `).run();
  const service = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, 3500, 10, 'active')
  `).run(client.lastInsertRowid);
  const router = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'router', 'MikroTik', 'hAP', 1, 6000, 2, 1)
  `).run();
  const cable = db.prepare(`
    INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('material', 'cabo', 'Cabo UTP', 'metro', 0, 80, 100, 1)
  `).run();

  return {
    clientId: Number(client.lastInsertRowid),
    serviceId: Number(service.lastInsertRowid),
    routerId: Number(router.lastInsertRowid),
    cableId: Number(cable.lastInsertRowid)
  };
}

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe('service install batch engine', () => {
  test('preflight rejects material lines without a positive quantity', () => {
    db = freshDb();
    const { cableId } = seedService(db);

    expect(preflightItems(db, [{ catalogId: cableId, quantity: 0 }])).toEqual({
      ok: false,
      status: 400,
      error: 'Quantidade de material invalida'
    });
  });

  test('installs serialized equipment and consumes material with one event', () => {
    db = freshDb();
    const { serviceId, routerId, cableId } = seedService(db);

    const run = db.transaction(() => installItemsWithinTx(db!, {
      serviceId,
      clientName: 'Cliente Batch',
      userId: null,
      items: [
        { catalogId: routerId, serialNumber: 'SN-BATCH-1', notes: 'Router instalado' },
        { catalogId: cableId, quantity: 25, notes: 'Cabo usado' }
      ]
    }));

    const result = run();

    expect(result.assignmentIds).toHaveLength(1);
    expect(result.materialLineIds).toHaveLength(1);
    expect(result.eventId).toEqual(expect.any(Number));
    expect(db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?').get(routerId))
      .toEqual({ stockTotal: 1 });
    expect(db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?').get(cableId))
      .toEqual({ stockTotal: 75 });
    expect(db.prepare('SELECT quantity, unit_cost_cve AS unitCostCve FROM service_material_lines WHERE catalog_id = ?').get(cableId))
      .toEqual({ quantity: 25, unitCostCve: 80 });
    expect(db.prepare('SELECT count(*) AS count FROM service_events WHERE service_id = ?').get(serviceId))
      .toEqual({ count: 1 });
  });
});
