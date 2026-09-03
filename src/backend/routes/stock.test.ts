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
    DELETE FROM backbone_devices;
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

  /**
   * O vocabulário deixou de ser fechado: o que o operador escreve fica à letra,
   * porque é assim que reaparece na lista de tipos do formulário.
   */
  test('creates equipment with a hand-written type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/equipment-catalog',
      payload: {
        category: 'equipamento',
        type: '  Ponto de Acesso  ',
        brand: 'TP-Link',
        model: 'EAP225',
        stockTotal: 1,
        // Nascer com stock e uma compra, e uma compra diz quanto custou.
        purchasePriceCve: 7000
      }
    });

    expect(response.statusCode).toBe(201);
    const id = (response.json() as { id: number }).id;
    expect(db.prepare('SELECT type FROM equipment_catalog WHERE id = ?').get(id))
      .toEqual({ type: 'Ponto de Acesso' });
  });

  test('rejects a blank type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/equipment-catalog',
      payload: { category: 'equipamento', type: '   ', model: 'Sem tipo' }
    });

    expect(response.statusCode).toBe(400);
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

  test('summary conta as unidades que estao no backbone', async () => {
    const catalogId = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, stock_total, active)
      VALUES ('equipamento','antena','TP-Link','CPE710',3,1)
    `).run().lastInsertRowid;
    const unidade = db.prepare('INSERT INTO backbone_devices (catalog_id, name, status) VALUES (?, ?, ?)');
    unidade.run(catalogId, 'Core Norte', 'active');
    unidade.run(catalogId, 'Core Sul', 'maintenance');
    unidade.run(catalogId, 'Core Velho', 'retired');

    const response = await app.inject({ method: 'GET', url: '/api/stock/summary' });
    const body = response.json() as { rows: Array<{ model: string; backboneCount: number }> };

    // A retirada ja voltou ao armazem: nao se conta duas vezes.
    expect(body.rows.find((r) => r.model === 'CPE710')?.backboneCount).toBe(2);
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

describe('o catalogo deixa rasto da compra', () => {
  const model = (over: Record<string, unknown> = {}) => ({
    category: 'equipamento', type: 'cpe', model: 'CPE710', unitOfMeasure: 'un',
    isSerialized: true, purchasePriceCve: 4000, shippingCostCve: 800,
    customsDutyCve: 200, otherCostsCve: 0, sellingPriceCve: 0, rentalFeeCve: 250,
    stockTotal: 3, usefulLifeMonths: 60, active: true, ...over
  });

  const capex = () => (db.prepare(`
    SELECT COALESCE(SUM(quantity * unit_cost_cve), 0) AS cve
    FROM stock_movements WHERE type = 'entrada'
  `).get() as { cve: number }).cve;

  test('criar com stock inicial regista a compra ao custo aterrado', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/equipment-catalog', payload: model() });
    expect(response.statusCode).toBe(201);
    // 4000+800+200 = 5000 por unidade, tres unidades.
    expect(capex()).toBe(15_000);
  });

  test('criar sem stock nao inventa uma compra', async () => {
    await app.inject({ method: 'POST', url: '/api/equipment-catalog', payload: model({ stockTotal: 0 }) });
    expect(capex()).toBe(0);
  });

  test('subir o stock e comprar; descer e corrigir a contagem', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/equipment-catalog', payload: model() });
    const id = (created.json() as { id: number }).id;

    await app.inject({ method: 'PUT', url: `/api/equipment-catalog/${id}`, payload: model({ stockTotal: 5 }) });
    expect(capex()).toBe(25_000);

    // Descer e uma correcao de inventario: mexe no saldo, nunca no capital.
    await app.inject({ method: 'PUT', url: `/api/equipment-catalog/${id}`, payload: model({ stockTotal: 1 }) });
    expect(capex()).toBe(25_000);
    const row = db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?')
      .get(id) as { stockTotal: number };
    expect(row.stockTotal).toBe(1);
  });

  test('guardar sem mexer no stock nao duplica a compra', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/equipment-catalog', payload: model() });
    const id = (created.json() as { id: number }).id;
    await app.inject({ method: 'PUT', url: `/api/equipment-catalog/${id}`, payload: model({ rentalFeeCve: 300 }) });
    expect(capex()).toBe(15_000);
  });
});

describe('uma compra tem de dizer quanto custou', () => {
  const model = (over: Record<string, unknown> = {}) => ({
    category: 'equipamento', type: 'cpe', model: 'CPE-custo', unitOfMeasure: 'un',
    isSerialized: true, purchasePriceCve: 4000, shippingCostCve: 0,
    customsDutyCve: 0, otherCostsCve: 0, sellingPriceCve: 0, rentalFeeCve: 0,
    stockTotal: 0, usefulLifeMonths: 60, active: true, ...over
  });

  async function seedModel(over: Record<string, unknown> = {}) {
    const r = await app.inject({ method: 'POST', url: '/api/equipment-catalog', payload: model(over) });
    return (r.json() as { id: number }).id;
  }

  test('recusa uma entrada de stock sem custo', async () => {
    const id = await seedModel();
    const r = await app.inject({
      method: 'POST', url: '/api/stock',
      payload: { catalogId: id, type: 'entrada', quantity: 5, unitCostCve: 0 }
    });
    expect(r.statusCode).toBe(400);
    // Nada entrou: nem movimento, nem stock.
    const mov = db.prepare(`SELECT COUNT(*) n FROM stock_movements WHERE catalog_id = ?`).get(id) as { n: number };
    expect(mov.n).toBe(0);
  });

  test('aceita saidas e ajustes sem custo — so a compra e capital', async () => {
    const id = await seedModel({ stockTotal: 10, purchasePriceCve: 4000 });
    for (const type of ['saida', 'ajuste']) {
      const r = await app.inject({
        method: 'POST', url: '/api/stock',
        payload: { catalogId: id, type, quantity: 1, unitCostCve: 0 }
      });
      expect(r.statusCode, `${type} devia passar`).toBe(201);
    }
  });

  test('recusa um modelo que nasce com stock e sem preco', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/equipment-catalog',
      payload: model({ stockTotal: 3, purchasePriceCve: 0 })
    });
    expect(r.statusCode).toBe(400);
  });

  test('um modelo sem stock pode nascer sem preco', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/equipment-catalog',
      payload: model({ model: 'Sem preco ainda', stockTotal: 0, purchasePriceCve: 0 })
    });
    expect(r.statusCode).toBe(201);
  });

  test('recusa acrescentar stock a um modelo sem preco, mas deixa corrigir para baixo', async () => {
    const id = await seedModel({ model: 'Corrige contagem', stockTotal: 0, purchasePriceCve: 0 });
    db.prepare('UPDATE equipment_catalog SET stock_total = 4 WHERE id = ?').run(id);

    const sobe = await app.inject({
      method: 'PUT', url: `/api/equipment-catalog/${id}`,
      payload: model({ model: 'Corrige contagem', stockTotal: 9, purchasePriceCve: 0 })
    });
    expect(sobe.statusCode).toBe(400);

    // Descer e uma correcao de contagem, e essa nao custa nada.
    const desce = await app.inject({
      method: 'PUT', url: `/api/equipment-catalog/${id}`,
      payload: model({ model: 'Corrige contagem', stockTotal: 1, purchasePriceCve: 0 })
    });
    expect(desce.statusCode).toBe(200);
  });
});

describe('uma compra nao pode ser negativa', () => {
  test('recusa uma entrada de quantidade negativa', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/equipment-catalog',
      payload: {
        category: 'equipamento', type: 'cpe', model: 'CPE-negativo', unitOfMeasure: 'un',
        isSerialized: true, purchasePriceCve: 5000, stockTotal: 10, active: true
      }
    });
    const id = (created.json() as { id: number }).id;

    const r = await app.inject({
      method: 'POST', url: '/api/stock',
      payload: { catalogId: id, type: 'entrada', quantity: -5, unitCostCve: 5000 }
    });
    expect(r.statusCode).toBe(400);

    // O caminho certo para o mesmo efeito continua aberto.
    const ajuste = await app.inject({
      method: 'POST', url: '/api/stock',
      payload: { catalogId: id, type: 'ajuste', quantity: -5, unitCostCve: 0 }
    });
    expect(ajuste.statusCode).toBe(201);
    const row = db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(id) as { s: number };
    expect(row.s).toBe(5);
  });
});

describe('a recusa explica-se', () => {
  test('a mensagem da guarda chega ao operador, nao um "invalido" generico', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/equipment-catalog',
      payload: {
        category: 'equipamento', type: 'cpe', model: 'CPE-mensagem', unitOfMeasure: 'un',
        isSerialized: true, purchasePriceCve: 5000, stockTotal: 5, active: true
      }
    });
    const id = (created.json() as { id: number }).id;

    const semCusto = await app.inject({
      method: 'POST', url: '/api/stock',
      payload: { catalogId: id, type: 'entrada', quantity: 2, unitCostCve: 0 }
    });
    expect(semCusto.statusCode).toBe(400);
    // O smoke do pacote apanhou isto: a rota devolvia "Movimento de stock
    // invalido" e mandava o operador adivinhar qual dos seis campos falhava.
    expect((semCusto.json() as { error: string }).error).toMatch(/custou/i);

    const negativa = await app.inject({
      method: 'POST', url: '/api/stock',
      payload: { catalogId: id, type: 'entrada', quantity: -2, unitCostCve: 5000 }
    });
    expect((negativa.json() as { error: string }).error).toMatch(/Ajuste/i);

    const zero = await app.inject({
      method: 'POST', url: '/api/stock',
      payload: { catalogId: id, type: 'ajuste', quantity: 0, unitCostCve: 0 }
    });
    expect((zero.json() as { error: string }).error).toMatch(/zero unidades/i);
  });
});
