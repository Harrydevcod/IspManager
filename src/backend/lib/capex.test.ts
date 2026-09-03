import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  externalInvestmentCapexCve,
  parkValue,
  portfolioRows,
  stockCapexByYear,
  stockCapexCve
} from './capex';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-capex-test-'));
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
    'payment_receipts',
    'payment_lines',
    'payments',
    'services',
    'investment_items',
    'investment_clients',
    'investments',
    'expenses',
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

function seedCatalog(model: string, priceCve: number, over: { stock?: number; life?: number } = {}): number {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog
      (category, type, brand, model, unit_of_measure, is_serialized, stock_total,
       purchase_price_cve, rental_fee_cve, useful_life_months)
    VALUES ('equipamento', 'cpe', 'TP-Link', ?, 'un', 1, ?, ?, 250, ?)
  `).run(model, over.stock ?? 0, priceCve, over.life ?? 60).lastInsertRowid);
}

function movement(catalogId: number, type: string, quantity: number, unitCostCve: number, at?: string) {
  db.prepare(`
    INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, created_at)
    VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(catalogId, type, quantity, unitCostCve, at ?? null);
}

function seedClient(name: string, zone: string | null = 'Achada'): number {
  return Number(db.prepare(`
    INSERT INTO clients (client_code, full_name, phone, island, zone, status)
    VALUES (?, ?, ?, 'Santiago', ?, 'active')
  `).run(`C-${name}`, name, `9${Math.floor(Math.random() * 10000000)}`, zone).lastInsertRowid);
}

function seedService(clientId: number): number {
  const planId = Number(db.prepare(`
    INSERT INTO internet_plans (name, monthly_price_cve, active) VALUES (?, 2500, 1)
  `).run(`P-${clientId}-${Math.random()}`).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO services (client_id, plan_id, status, activation_date, monthly_value_cve)
    VALUES (?, ?, 'active', date('now', '-12 months'), 2500)
  `).run(clientId, planId).lastInsertRowid);
}

function assign(serviceIds: number[], catalogId: number, startDate: string, endDate?: string): number {
  const assignmentId = Number(db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, start_date, end_date, ownership)
    VALUES (?, ?, ?, ?, 'isp')
  `).run(serviceIds[0], catalogId, startDate, endDate ?? null).lastInsertRowid);
  // A vista `assignment_services` ja conta o titular; so as partilhas se inserem.
  for (const serviceId of serviceIds.slice(1)) {
    db.prepare('INSERT INTO service_device_shares (assignment_id, service_id) VALUES (?, ?)')
      .run(assignmentId, serviceId);
  }
  return assignmentId;
}

function invoice(clientId: number, serviceId: number, month: string, amountCve: number, receivedCve: number) {
  const paymentId = Number(db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(clientId, serviceId, month, amountCve, `${month}-30`,
    receivedCve >= amountCve ? 'paid' : 'pending').lastInsertRowid);
  if (receivedCve > 0) {
    db.prepare(`
      INSERT INTO payment_receipts
        (payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date)
      VALUES (?, ?, ?, 'numerario', 'cash', ?, ?)
    `).run(paymentId, receivedCve, `${month}-05`, `RC-${paymentId}`, `${month}-05`);
  }
  return paymentId;
}

// ------------------------------------------------------------------ tests

describe('capital de stock', () => {
  test('o ciclo devolucao-reinstalacao nao inventa capital', () => {
    // A conta antiga (saldo + saidas) subia para 10.000$ ao fim do terceiro
    // passo: a devolucao repunha o saldo sem anular a saida. Foi comprada UMA
    // unidade — o capital e 5.000$ nos quatro momentos.
    const cpe = seedCatalog('CPE710', 5000, { stock: 0 });

    movement(cpe, 'entrada', 1, 5000);
    db.prepare('UPDATE equipment_catalog SET stock_total = 1 WHERE id = ?').run(cpe);
    expect(stockCapexCve()).toBe(5000);

    movement(cpe, 'saida', 1, 5000);
    db.prepare('UPDATE equipment_catalog SET stock_total = 0 WHERE id = ?').run(cpe);
    expect(stockCapexCve()).toBe(5000);

    movement(cpe, 'devolucao', 1, 5000);
    db.prepare('UPDATE equipment_catalog SET stock_total = 1 WHERE id = ?').run(cpe);
    expect(stockCapexCve()).toBe(5000);

    movement(cpe, 'saida', 1, 5000);
    db.prepare('UPDATE equipment_catalog SET stock_total = 0 WHERE id = ?').run(cpe);
    expect(stockCapexCve()).toBe(5000);
  });

  test('conta cada compra ao custo com que foi comprada, nao ao de hoje', () => {
    const cpe = seedCatalog('CPE510', 9000);
    movement(cpe, 'entrada', 2, 4000);
    movement(cpe, 'entrada', 3, 6000);
    expect(stockCapexCve()).toBe(2 * 4000 + 3 * 6000);
  });

  test('reparte o capital pelo ano civil da compra', () => {
    const cpe = seedCatalog('CPE710', 5000);
    movement(cpe, 'entrada', 1, 5000, '2025-03-04 10:00:00');
    movement(cpe, 'entrada', 2, 5000, '2026-01-09 10:00:00');
    movement(cpe, 'saida', 1, 5000, '2026-02-01 10:00:00');

    const byYear = Object.fromEntries(stockCapexByYear().map((r) => [r.year, r.capexCve]));
    expect(byYear).toEqual({ '2025': 5000, '2026': 10000 });
    expect(Object.values(byYear).reduce((a, b) => a + b, 0)).toBe(stockCapexCve());
  });
});

describe('capital de investimento', () => {
  function seedInvestment(name: string, totalCve: number): number {
    return Number(db.prepare(`
      INSERT INTO investments (name, type, investment_date, reference_month, status, total_cost_cve)
      VALUES (?, 'zona', '2026-01-10', '2026-01', 'ativo', ?)
    `).run(name, totalCve).lastInsertRowid);
  }
  function seedItem(investmentId: number, name: string, totalCve: number, catalogId?: number) {
    db.prepare(`
      INSERT INTO investment_items
        (investment_id, item_type, item_name, quantity, unit_cost_cve, total_cost_cve, catalog_id)
      VALUES (?, 'outro', ?, 1, ?, ?, ?)
    `).run(investmentId, name, totalCve, totalCve, catalogId ?? null);
  }

  test('um item ligado ao catalogo nao soma — ja contou no stock', () => {
    const cpe = seedCatalog('CPE710', 5000);
    const inv = seedInvestment('Expansao Achada', 100000);
    seedItem(inv, 'Seis CPE', 30000, cpe);
    seedItem(inv, 'Mao de obra', 12000);

    expect(externalInvestmentCapexCve()).toBe(12000);
  });

  test('um investimento sem itens mantem o custo declarado', () => {
    seedInvestment('Poste do Monte', 45000);
    expect(externalInvestmentCapexCve()).toBe(45000);
  });
});

describe('parque instalado', () => {
  test('deprecia em linha reta e conta a unidade fisica uma vez', () => {
    const antena = seedCatalog('CPE710', 6000, { life: 60 });
    const a = seedService(seedClient('Ana'));
    const b = seedService(seedClient('Bruno'));
    // Uma antena partilhada por dois servicos, instalada ha 30 meses.
    assign([a, b], antena, new Date(Date.now() - 30 * 30.44 * 86400000).toISOString().slice(0, 10));

    const park = parkValue();
    // Uma antena partilhada continua a ser UMA antena: o parque nao a reparte.
    expect(park.units).toBe(1);
    // Metade da vida util consumida: sobra metade dos 6.000$ (a folga absorve o
    // mes medio de 30,44 dias do seed).
    expect(park.netValueCve).toBeCloseTo(3000, -1);
    expect(park.monthlyDepreciationCve).toBeCloseTo(100, 6);
  });

  test('equipamento retirado sai do parque', () => {
    const antena = seedCatalog('CPE710', 6000);
    const s = seedService(seedClient('Carla'));
    assign([s], antena, '2026-01-01', '2026-06-01');
    expect(parkValue().units).toBe(0);
    expect(parkValue().netValueCve).toBe(0);
  });
});

describe('carteira', () => {
  test('imputa o equipamento partilhado a cada titular uma so vez', () => {
    const antena = seedCatalog('CPE710', 6000);
    const ana = seedClient('Ana');
    const bruno = seedClient('Bruno');
    assign([seedService(ana), seedService(bruno)], antena, '2026-01-01');

    const rows = portfolioRows();
    const total = rows.reduce((sum, r) => sum + r.installedEquipmentCostCve, 0);
    expect(total).toBeCloseTo(6000, 6);
    expect(rows.find((r) => r.clientId === ana)!.installedEquipmentCostCve).toBeCloseTo(3000, 6);
  });

  test('conta o recebido dos recibos, nao o valor cheio da fatura', () => {
    const ana = seedClient('Ana');
    const service = seedService(ana);
    invoice(ana, service, '2026-06', 3500, 1200);

    const row = portfolioRows([ana])[0];
    expect(row.paidRevenueCve).toBe(1200);
  });

  test('capital por recuperar e o que falta devolver, nunca negativo', () => {
    const antena = seedCatalog('CPE710', 6000);
    const ana = seedClient('Ana');
    const service = seedService(ana);
    assign([service], antena, '2026-01-01');
    invoice(ana, service, '2026-06', 2500, 2500);

    const row = portfolioRows([ana])[0];
    expect(row.installationCostCve).toBeCloseTo(6000, 6);
    expect(row.unrecoveredCve).toBeGreaterThan(0);
    expect(row.isRecovered).toBe(false);

    // Recebido acima do capital: nada por recuperar, e o sinal nao vira negativo.
    for (const month of ['2026-07', '2026-08', '2026-09']) invoice(ana, service, month, 2500, 2500);
    const after = portfolioRows([ana])[0];
    expect(after.isRecovered).toBe(true);
    expect(after.unrecoveredCve).toBe(0);
  });

  test('a margem mensal desconta o desgaste do equipamento', () => {
    const antena = seedCatalog('CPE710', 6000, { life: 60 });
    const ana = seedClient('Ana');
    const service = seedService(ana);
    assign([service], antena, '2026-01-01');
    invoice(ana, service, '2026-06', 2500, 2500);

    const row = portfolioRows([ana])[0];
    expect(row.monthlyDepreciationCve).toBeCloseTo(100, 6);
    expect(row.monthlyMarginCve).toBeCloseTo(row.monthlyNetProfitCve - 100, 6);
  });

  test('um cliente sem nada nao rebenta a conta', () => {
    const ana = seedClient('Ana');
    const row = portfolioRows([ana])[0];
    expect(row.installationCostCve).toBe(0);
    expect(row.profitabilityPct).toBeNull();
    expect(row.monthsToBreakeven).toBeNull();
    expect(row.isRecovered).toBe(false);
  });

  test('a carteira toda e a carteira de um dao o mesmo numero', () => {
    const antena = seedCatalog('CPE710', 6000);
    const ana = seedClient('Ana');
    const service = seedService(ana);
    assign([service], antena, '2026-01-01');
    invoice(ana, service, '2026-06', 2500, 2500);

    const fromAll = portfolioRows().find((r) => r.clientId === ana)!;
    const fromOne = portfolioRows([ana])[0];
    expect(fromOne).toEqual(fromAll);
  });
});
