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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-stock-test-'));
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
    DELETE FROM service_material_lines;
    DELETE FROM stock_movements;
    DELETE FROM equipment_catalog;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('catalog schema (0018)', () => {
  test('equipment rows default to serialized equipamento in units', () => {
    const id = db.prepare(`
      INSERT INTO equipment_catalog (type, brand, model, stock_total, active)
      VALUES ('router', 'MikroTik', 'hAP', 5, 1)
    `).run().lastInsertRowid as number;

    expect(db.prepare(`
      SELECT category, unit_of_measure AS unit, is_serialized AS serialized
      FROM equipment_catalog WHERE id = ?
    `).get(id)).toEqual({ category: 'equipamento', unit: 'un', serialized: 1 });
  });

  test('accepts a material catalog row measured in metres', () => {
    const id = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_centavos, stock_total, active)
      VALUES ('material', 'cabo', 'Cabo UTP Cat6', 'metro', 0, 8000, 305, 1)
    `).run().lastInsertRowid as number;

    expect(db.prepare(`
      SELECT category, type, unit_of_measure AS unit, is_serialized AS serialized
      FROM equipment_catalog WHERE id = ?
    `).get(id)).toEqual({ category: 'material', type: 'cabo', unit: 'metro', serialized: 0 });
  });

  test('service_material_lines rejects non-positive quantity', () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-M','M','active')`).run().lastInsertRowid;
    const service = db.prepare(`INSERT INTO services (client_id, monthly_value_centavos, due_day, status) VALUES (?, 350000, 10, 'active')`).run(client).lastInsertRowid;
    const catalog = db.prepare(`INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total) VALUES ('material','cabo','UTP','metro',0,100)`).run().lastInsertRowid;

    expect(() => db.prepare(`
      INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_centavos)
      VALUES (?, ?, 0, 8000)
    `).run(service, catalog)).toThrow();
  });
});

describe('POST /api/equipment-catalog with materials', () => {
  test('creates a material item with unit and category', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/equipment-catalog',
      payload: {
        category: 'material',
        type: 'cabo',
        model: 'Cabo UTP Cat6',
        unitOfMeasure: 'metro',
        isSerialized: false,
        purchasePriceCve: 80,
        stockTotal: 305
      }
    });

    expect(response.statusCode).toBe(201);
    const id = (response.json() as { id: number }).id;
    expect(db.prepare(`
      SELECT category, type, unit_of_measure AS unit, is_serialized AS serialized
      FROM equipment_catalog WHERE id = ?
    `).get(id)).toEqual({ category: 'material', type: 'cabo', unit: 'metro', serialized: 0 });
  });

  test('summary returns category, unit and isSerialized', async () => {
    db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total, active)
      VALUES ('material','conector','RJ45','un',0,200,1)
    `).run();

    const response = await app.inject({ method: 'GET', url: '/api/stock/summary' });
    const body = response.json() as { rows: Array<{ category: string; unitOfMeasure: string; isSerialized: number; model: string }> };
    const row = body.rows.find((r) => r.model === 'RJ45');
    expect(row).toMatchObject({ category: 'material', unitOfMeasure: 'un', isSerialized: 0 });
  });
});
