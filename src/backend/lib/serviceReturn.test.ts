import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  mapReturnError,
  pendingMaterialQuantity,
  processServiceReturn,
  recoverMaterialWithinTx,
  returnAssignmentWithinTx
} from './serviceReturn';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-return-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of [
    'service_device_shares',
    'stock_movements',
    'service_material_lines',
    'service_install_costs',
    'service_events',
    'service_device_assignments',
    'payment_lines',
    'payments',
    'services',
    'clients',
    'equipment_catalog',
    'internet_plans'
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

// ------------------------------------------------------------------ seeds

function seedCatalog(model: string, over: { stock?: number; serialized?: boolean } = {}): number {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, unit_of_measure, is_serialized, stock_total, purchase_price_cve, rental_fee_cve)
    VALUES ('equipamento', 'antena', 'TP-Link', ?, 'un', ?, ?, 6000, 250)
  `).run(model, over.serialized === false ? 0 : 1, over.stock ?? 5).lastInsertRowid);
}

function seedService(name: string): { serviceId: number; clientName: string } {
  const clientId = Number(db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(`C${name}`, name).lastInsertRowid);
  const serviceId = Number(db.prepare(`
    INSERT INTO services (client_id, status, monthly_value_cve, due_day)
    VALUES (?, 'active', 2500, 10)
  `).run(clientId).lastInsertRowid);
  return { serviceId, clientName: name };
}

function assign(serviceId: number, catalogId: number): number {
  return Number(db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, start_date, ownership, rental_fee_cve)
    VALUES (?, ?, date('now'), 'isp', 250)
  `).run(serviceId, catalogId).lastInsertRowid);
}

function consumeMaterial(serviceId: number, catalogId: number, quantity: number) {
  db.prepare(`
    INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_cve)
    VALUES (?, ?, ?, 100)
  `).run(serviceId, catalogId, quantity);
  db.prepare(`
    INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, service_id)
    VALUES (?, 'saida', ?, 100, ?)
  `).run(catalogId, quantity, serviceId);
  db.prepare('UPDATE equipment_catalog SET stock_total = stock_total - ? WHERE id = ?').run(quantity, catalogId);
}

const stockOf = (catalogId: number) =>
  (db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(catalogId) as { s: number }).s;

const assignmentRow = (id: number) =>
  db.prepare('SELECT end_date AS endDate, return_condition AS returnCondition FROM service_device_assignments WHERE id = ?')
    .get(id) as { endDate: string | null; returnCondition: string | null };

// ------------------------------------------------------------ equipamento

describe('devolução de equipamento', () => {
  test('em bom estado volta ao stock', () => {
    const { serviceId, clientName } = seedService('Anilsa');
    const catalogId = seedCatalog('CPE 510', { stock: 4 });
    const assignmentId = assign(serviceId, catalogId);

    const result = returnAssignmentWithinTx(db, { assignmentId, clientName, condition: 'bom', userId: null });

    expect(result.restoredStock).toBe(true);
    expect(stockOf(catalogId)).toBe(5);
    expect(assignmentRow(assignmentId)).toMatchObject({ returnCondition: 'bom' });
    expect(assignmentRow(assignmentId).endDate).not.toBeNull();
  });

  test('avariado fecha a atribuição mas não repõe stock', () => {
    const { serviceId, clientName } = seedService('Djamila');
    const catalogId = seedCatalog('CPE 710', { stock: 4 });
    const assignmentId = assign(serviceId, catalogId);

    const result = returnAssignmentWithinTx(db, { assignmentId, clientName, condition: 'avariado', userId: null });

    expect(result.restoredStock).toBe(false);
    expect(stockOf(catalogId)).toBe(4);
    expect(assignmentRow(assignmentId).returnCondition).toBe('avariado');
    expect(assignmentRow(assignmentId).endDate).not.toBeNull();
  });

  test('não devolvido também corta a renda — o que conta é a data de fim', () => {
    const { serviceId, clientName } = seedService('Nilton');
    const catalogId = seedCatalog('TL-S5', { stock: 3 });
    const assignmentId = assign(serviceId, catalogId);

    returnAssignmentWithinTx(db, { assignmentId, clientName, condition: 'nao_devolvido', userId: null });

    const active = db.prepare(`
      SELECT COUNT(*) AS total FROM service_device_assignments
      WHERE service_id = ? AND end_date IS NULL AND ownership = 'isp' AND rental_fee_cve > 0
    `).get(serviceId) as { total: number };
    expect(active.total).toBe(0);
    expect(stockOf(catalogId)).toBe(3);
  });

  test('uma atribuição já encerrada não devolve duas vezes', () => {
    const { serviceId, clientName } = seedService('Zé');
    const catalogId = seedCatalog('CPE 220', { stock: 2 });
    const assignmentId = assign(serviceId, catalogId);
    returnAssignmentWithinTx(db, { assignmentId, clientName, userId: null });

    expect(() => returnAssignmentWithinTx(db, { assignmentId, clientName, userId: null }))
      .toThrow('already_closed');
    expect(stockOf(catalogId)).toBe(3);
  });

  test('antena partilhada recusa a devolução', () => {
    const { serviceId, clientName } = seedService('Titular');
    const other = seedService('Partilha');
    const catalogId = seedCatalog('CPE 510', { stock: 1 });
    const assignmentId = assign(serviceId, catalogId);
    db.prepare('INSERT INTO service_device_shares (assignment_id, service_id) VALUES (?, ?)')
      .run(assignmentId, other.serviceId);

    expect(() => returnAssignmentWithinTx(db, { assignmentId, clientName, userId: null }))
      .toThrow(/^device_shared:/);
    expect(assignmentRow(assignmentId).endDate).toBeNull();
  });
});

// --------------------------------------------------------------- materiais

describe('recuperação de material', () => {
  test('recupera parcialmente e o resto fica consumido', () => {
    const { serviceId, clientName } = seedService('Maria');
    const catalogId = seedCatalog('Cabo UTP', { stock: 100, serialized: false });
    consumeMaterial(serviceId, catalogId, 50);
    expect(stockOf(catalogId)).toBe(50);

    recoverMaterialWithinTx(db, { serviceId, clientName, catalogId, quantity: 30, userId: null });

    expect(stockOf(catalogId)).toBe(80);
    expect(pendingMaterialQuantity(db, serviceId, catalogId)).toBe(20);
  });

  test('não recupera mais do que saiu para este serviço', () => {
    const { serviceId, clientName } = seedService('Ana');
    const catalogId = seedCatalog('Cabo UTP', { stock: 100, serialized: false });
    consumeMaterial(serviceId, catalogId, 50);
    recoverMaterialWithinTx(db, { serviceId, clientName, catalogId, quantity: 30, userId: null });

    expect(() => recoverMaterialWithinTx(db, { serviceId, clientName, catalogId, quantity: 25, userId: null }))
      .toThrow('recover_exceeds:20');
    expect(stockOf(catalogId)).toBe(80);
  });
});

// -------------------------------------------------------------- lote inteiro

describe('processServiceReturn', () => {
  test('um bom e um avariado somam uma unidade só, e fica um evento de resumo', () => {
    const { serviceId, clientName } = seedService('Cancelado');
    const antena = seedCatalog('CPE 510', { stock: 0 });
    const router = seedCatalog('Archer C6', { stock: 0 });
    const cabo = seedCatalog('Cabo UTP', { stock: 100, serialized: false });
    const antenaId = assign(serviceId, antena);
    const routerId = assign(serviceId, router);
    consumeMaterial(serviceId, cabo, 50);

    const result = processServiceReturn(db, {
      serviceId,
      clientName,
      devices: [
        { assignmentId: antenaId, condition: 'bom' },
        { assignmentId: routerId, condition: 'avariado' }
      ],
      materials: [{ catalogId: cabo, quantity: 30 }],
      userId: null
    });

    expect(stockOf(antena)).toBe(1);
    expect(stockOf(router)).toBe(0);
    expect(stockOf(cabo)).toBe(80);
    expect(result.devices).toHaveLength(2);

    const events = db.prepare(`
      SELECT notes FROM service_events WHERE service_id = ? ORDER BY id DESC
    `).all(serviceId) as Array<{ notes: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].notes).toContain('2 equipamento(s) devolvido(s)');
    expect(events[0].notes).toContain('avariado');
    expect(events[0].notes).toContain('30 un de material recuperado');
  });

  test('uma partilha a meio desfaz o lote todo', () => {
    const { serviceId, clientName } = seedService('Titular');
    const other = seedService('Vizinho');
    const antena = seedCatalog('CPE 510', { stock: 0 });
    const router = seedCatalog('Archer C6', { stock: 0 });
    const routerId = assign(serviceId, router);
    const antenaId = assign(serviceId, antena);
    db.prepare('INSERT INTO service_device_shares (assignment_id, service_id) VALUES (?, ?)')
      .run(antenaId, other.serviceId);

    expect(() => db.transaction(() => processServiceReturn(db, {
      serviceId,
      clientName,
      devices: [
        { assignmentId: routerId, condition: 'bom' },
        { assignmentId: antenaId, condition: 'bom' }
      ],
      materials: [],
      userId: null
    }))()).toThrow(/^device_shared:/);

    // O router, que ia primeiro no lote, tem de ficar exatamente como estava.
    expect(assignmentRow(routerId).endDate).toBeNull();
    expect(stockOf(router)).toBe(0);
  });

  test('equipamento de outro serviço não entra pelo lote', () => {
    const { serviceId, clientName } = seedService('Meu');
    const outro = seedService('Alheio');
    const catalogId = seedCatalog('CPE 510', { stock: 0 });
    const assignmentId = assign(outro.serviceId, catalogId);

    expect(() => processServiceReturn(db, {
      serviceId,
      clientName,
      devices: [{ assignmentId, condition: 'bom' }],
      materials: [],
      userId: null
    })).toThrow('assignment_other_service');
  });
});

describe('mapReturnError', () => {
  test('a partilha explica quem fica sem sinal', () => {
    const mapped = mapReturnError(new Error('device_shared:Ana, Zé'));
    expect(mapped).toEqual({
      status: 409,
      error: 'Esta antena serve tambem 2 servico(s): Ana, Zé. Remova as partilhas primeiro.'
    });
  });

  test('o excesso de material diz quanto ainda falta', () => {
    expect(mapReturnError(new Error('recover_exceeds:20'))?.status).toBe(400);
    expect(mapReturnError(new Error('recover_exceeds:20'))?.error).toContain('20');
  });
});
