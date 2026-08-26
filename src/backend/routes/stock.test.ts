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
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material', 'cabo', 'Cabo UTP Cat6', 'metro', 0, 80, 305, 1)
    `).run().lastInsertRowid as number;

    expect(db.prepare(`
      SELECT category, type, unit_of_measure AS unit, is_serialized AS serialized
      FROM equipment_catalog WHERE id = ?
    `).get(id)).toEqual({ category: 'material', type: 'cabo', unit: 'metro', serialized: 0 });
  });

  test('service_material_lines rejects non-positive quantity', () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-M','M','active')`).run().lastInsertRowid;
    const service = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 3500, 10, 'active')`).run(client).lastInsertRowid;
    const catalog = db.prepare(`INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total) VALUES ('material','cabo','UTP','metro',0,100)`).run().lastInsertRowid;

    expect(() => db.prepare(`
      INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_cve)
      VALUES (?, ?, 0, 80)
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

  /** O que está atrás da antena do cliente nem sempre é um router. */
  test('creates a wifi repeater, the equipment behind the client antenna', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/equipment-catalog',
      payload: {
        category: 'equipamento',
        type: 'repetidor',
        brand: 'iwipi',
        model: 'Wi-Fi Repeater',
        purchasePriceCve: 1500,
        stockTotal: 2
      }
    });

    expect(response.statusCode).toBe(201);
    const id = (response.json() as { id: number }).id;
    expect(db.prepare('SELECT type FROM equipment_catalog WHERE id = ?').get(id))
      .toEqual({ type: 'repetidor' });
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
    expect(row).not.toHaveProperty('backboneQty');
  });
});

describe('erros de validacao do catalogo', () => {
  const valid = {
    category: 'equipamento', type: 'router', brand: 'Teste', model: 'Modelo Val',
    supplier: '', unitOfMeasure: 'un', isSerialized: true,
    purchasePriceCve: 1000, sellingPriceCve: 0, rentalFeeCve: 0,
    stockTotal: 0, active: true
  };

  test('names the offending field instead of a blanket message', async () => {
    // Stock decimal e o caso real: para material medido em metros escrever 150.5
    // e natural, e o backend so aceita inteiros.
    const response = await app.inject({
      method: 'POST',
      url: '/api/equipment-catalog',
      payload: { ...valid, category: 'material', type: 'cabo', unitOfMeasure: 'metro', stockTotal: 150.5 }
    });

    expect(response.statusCode).toBe(400);
    const error = (response.json() as { error: string }).error;
    expect(error).toContain('Stock');
    expect(error).toContain('inteiro');
    expect(error).not.toBe('Dados de equipamento invalidos');
  });

  test('names the field for each reachable form mistake', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ model: '   ' }, 'Designacao'],
      [{ unitOfMeasure: '' }, 'Unidade de medida'],
      [{ purchasePriceCve: -1 }, 'Custo de compra']
    ];

    for (const [patch, expected] of cases) {
      const response = await app.inject({ method: 'POST', url: '/api/equipment-catalog', payload: { ...valid, ...patch } });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { error: string }).error).toContain(expected);
    }
  });

  test('rejects retired backbone quantity on catalog creation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/equipment-catalog',
      payload: { ...valid, backboneQty: 2 }
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('backboneQty');
    expect(db.prepare('SELECT COUNT(*) AS count FROM equipment_catalog').get())
      .toEqual({ count: 0 });
  });

  test('rejects retired backbone quantity on catalog update', async () => {
    const catalogId = db.prepare(`
      INSERT INTO equipment_catalog (type, brand, model, stock_total, active)
      VALUES ('router', 'Teste', 'Antes', 3, 1)
    `).run().lastInsertRowid;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/equipment-catalog/${catalogId}`,
      payload: { ...valid, model: 'Depois', backboneQty: 2 }
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('backboneQty');
    expect(db.prepare('SELECT model FROM equipment_catalog WHERE id = ?').get(catalogId))
      .toEqual({ model: 'Antes' });
  });

  test('still accepts a well-formed catalog entry', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/equipment-catalog', payload: valid });
    expect(response.statusCode).toBe(201);
    const savedCatalog = db.prepare('SELECT * FROM equipment_catalog WHERE id = ?')
      .get((response.json() as { id: number }).id);
    expect(savedCatalog).not.toHaveProperty('backbone_qty');
  });
});
