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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-investments-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

/**
 * Fatura paga = fatura + recibo. Desde a migracao 0052 e o recibo que e a
 * caixa, e a rentabilidade le recibos: uma linha 'paid' sem recibo e um estado
 * que a producao nao sabe produzir — a migracao fez o backfill de todo o
 * historico e o `payPayment` escreve sempre um.
 */
function insertPayment(sql: string, ...params: unknown[]): number {
  const id = db.prepare(sql).run(...params).lastInsertRowid as number;
  const row = db.prepare(`
    SELECT status, amount_cve AS amountCve, payment_date AS paymentDate, due_date AS dueDate
    FROM payments WHERE id = ?
  `).get(id) as { status: string; amountCve: number; paymentDate: string | null; dueDate: string };
  if (row.status === 'paid') {
    const when = row.paymentDate ?? row.dueDate;
    db.prepare(`
      INSERT INTO payment_receipts (payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date)
      VALUES (?, ?, ?, 'numerario', 'cash', ?, ?)
    `).run(id, row.amountCve, when, `T-${id}`, when);
  }
  return id;
}

beforeEach(() => {
  db.prepare('DELETE FROM backbone_assignment_links').run();
  db.prepare('DELETE FROM backbone_devices').run();
  db.prepare('DELETE FROM stock_movements').run();
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM investment_clients').run();
  db.prepare('DELETE FROM investment_items').run();
  db.prepare('DELETE FROM investments').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM internet_plans').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('investments CRUD', () => {
  test('creates, lists, updates and deletes an investment with calculated items', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/investments',
      payload: {
        name: 'Instalacao Achada Santo Antonio',
        type: 'zona',
        zone: 'Achada Santo Antonio',
        investmentDate: '2026-05-05',
        targetClients: 10,
        installedClients: 4,
        desiredPaybackMonths: 6,
        desiredMarginPct: 30,
        expectedMonthlyRevenueCve: 18000,
        monthlyOperationalCostCve: 3000,
        accumulatedRevenueCve: 9000,
        items: [
          { itemType: 'router', itemName: 'Router principal', quantity: 2, quantityUsed: 1, unitCostCve: 5000 },
          { itemType: 'cabo', itemName: 'Cabo UTP', quantity: 40, quantityUsed: 12, unitCostCve: 75 }
        ]
      }
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as number;

    const listMonth = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    expect(listMonth.statusCode).toBe(200);
    const body = listMonth.json();
    expect(body.rows).toHaveLength(1);
    expect(body.totals.totalCostCve).toBe(13000);
    expect(body.rows[0]).toMatchObject({
      name: 'Instalacao Achada Santo Antonio',
      zone: 'Achada Santo Antonio',
      totalCostCve: 13000,
      expectedMonthlyRevenueCve: 18000,
      monthlyNetProfitCve: 15000,
      costPerClientCve: 1300
    });
    expect(body.rows[0].items).toHaveLength(2);
    expect(body.rows[0].items[1].quantityRemaining).toBe(28);
    expect(body.rows[0].recommendedPlanCve).toBeCloseTo(1256.67, 2);
    expect(body.rows[0].roiPct).toBeCloseTo(-30.769, 2);
    // ROI anual convencional: (15000×12)/13000 — retorno anualizado sobre o capital.
    expect(body.rows[0].annualRoiPct).toBeCloseTo(1384.615, 2);

    const update = await app.inject({
      method: 'PUT',
      url: `/api/investments/${id}`,
      payload: {
        name: 'Cliente empresarial Palmarejo',
        type: 'cliente',
        zone: 'Palmarejo',
        investmentDate: '2026-05-07',
        status: 'ativo',
        expectedMonthlyRevenueCve: 10000,
        items: [
          { itemType: 'cpe', itemName: 'CPE 5GHz', quantity: 1, unitCostCve: 7000 },
          { itemType: 'mao_obra', itemName: 'Instalacao tecnica', quantity: 1, unitCostCve: 2500 }
        ]
      }
    });
    expect(update.statusCode).toBe(200);

    const after = db.prepare('SELECT name, total_cost_cve AS totalCostCve FROM investments WHERE id = ?')
      .get(id) as { name: string; totalCostCve: number };
    expect(after).toEqual({ name: 'Cliente empresarial Palmarejo', totalCostCve: 9500 });

    const remove = await app.inject({ method: 'DELETE', url: `/api/investments/${id}` });
    expect(remove.statusCode).toBe(200);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM investments').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  test('filters by month, type and zone', async () => {
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, total_cost_cve)
                VALUES ('Zona Mar', 'zona', 'Vila Nova', '2026-03-01', '2026-03', 10)`).run();
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, total_cost_cve)
                VALUES ('CPE Mar', 'equipamento', 'Vila Nova', '2026-03-15', '2026-03', 20)`).run();
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, total_cost_cve)
                VALUES ('Zona Abr', 'zona', 'Palmarejo', '2026-04-01', '2026-04', 30)`).run();

    const march = await app.inject({ method: 'GET', url: '/api/investments?month=2026-03' });
    expect(march.json().rows).toHaveLength(2);

    const marchZone = await app.inject({ method: 'GET', url: '/api/investments?month=2026-03&type=zona&zone=Vila%20Nova' });
    expect(marchZone.json().rows).toHaveLength(1);
    expect(marchZone.json().totals.totalCostCve).toBe(10);
  });

  test('imputes a pro-rata share of company OPEX based on installed clients', async () => {
    // Two active investments sharing 10 installed clients (6 + 4).
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Backbone', 'infraestrutura', '2026-05-01', '2026-05', 60000, 10, 6, 'ativo', 30000, 0)`).run();
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Edge zona', 'zona', '2026-05-01', '2026-05', 20000, 4, 4, 'ativo', 16000, 0)`).run();

    // 30k of OPEX spread across two months → avg 15k/month.
    db.prepare(`INSERT INTO expenses
                (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Abril', 12000, '2026-04-10', '2026-04')`).run();
    db.prepare(`INSERT INTO expenses
                (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Maio', 12000, '2026-05-10', '2026-05')`).run();
    db.prepare(`INSERT INTO expenses
                (category, description, amount_cve, expense_date, reference_month)
                VALUES ('salarios', 'Salarios Maio', 6000, '2026-05-30', '2026-05')`).run();
    // avgMonthlyOpex = 30000 / 2 = 15000; opexPerClient = 15000 / 10 = 1500.

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      rows: Array<{ name: string; imputedMonthlyOpexCve: number; effectiveMonthlyOpexCve: number; monthlyNetProfitCve: number }>;
      companyOpexShare: { avgMonthlyOpex: number; opexPerClientPerMonth: number; totalInstalledActive: number };
      totals: { totalImputedOpexCve: number; totalEffectiveOpexCve: number };
    };

    expect(body.companyOpexShare.avgMonthlyOpex).toBe(15000);
    expect(body.companyOpexShare.totalInstalledActive).toBe(10);
    expect(body.companyOpexShare.opexPerClientPerMonth).toBe(1500);

    const backbone = body.rows.find((r) => r.name === 'Backbone')!;
    const edge = body.rows.find((r) => r.name === 'Edge zona')!;
    expect(backbone.imputedMonthlyOpexCve).toBe(9000); // 6 clients × 1500
    expect(backbone.effectiveMonthlyOpexCve).toBe(9000);
    expect(backbone.monthlyNetProfitCve).toBe(21000); // 30000 - 9000

    expect(edge.imputedMonthlyOpexCve).toBe(6000); // 4 × 1500
    expect(edge.effectiveMonthlyOpexCve).toBe(6000);
    expect(edge.monthlyNetProfitCve).toBe(10000); // 16000 - 6000

    expect(body.totals.totalImputedOpexCve).toBe(15000); // = avgMonthlyOpex
    expect(body.totals.totalEffectiveOpexCve).toBe(15000);
  });

  test('combines direct OPEX with the imputed share', async () => {
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Cliente VIP', 'cliente', '2026-05-01', '2026-05', 8000, 1, 1, 'ativo', 5000, 750)`).run();
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('infraestrutura', 'Aluguer torre', 2000, '2026-05-01', '2026-05')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    const row = (response.json() as { rows: Array<{ imputedMonthlyOpexCve: number; effectiveMonthlyOpexCve: number; monthlyNetProfitCve: number }> }).rows[0];

    // avgMonthlyOpex = 2000 (1 month); opexPerClient = 2000 / 1 = 2000.
    expect(row.imputedMonthlyOpexCve).toBe(2000);
    expect(row.effectiveMonthlyOpexCve).toBe(2750); // 750 direct + 2000 imputed
    expect(row.monthlyNetProfitCve).toBe(2250); // 5000 - 2750
  });

  test('"Total investido" = equipamento comprado + custo externo dos investimentos', async () => {
    // Custo landed = 1200+200+100 = 1500/unid. Compraram-se 14: 10 ficaram em
    // armazem e 4 sairam para clientes.
    const catalogId = db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total)
                VALUES ('router', 'hAP ax2', 1200, 200, 100, 0, 10)`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'entrada', 14, 1500)`).run(catalogId);
    // 4 unidades ja sairam (instaladas), valorizadas ao custo landed.
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'saida', 4, 1500)`).run(catalogId);
    // Investimento manual (tabela investments) que tambem entra no total.
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve, status)
                VALUES ('Torre Achada', 'infraestrutura', '2026-05-01', '2026-05', 5000, 'ativo')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { totals: { totalInvestedCve: number } };
    // compras 14×1500=21000; + investimentos 5000 = 26000
    expect(payload.totals.totalInvestedCve).toBe(26000);
  });

  test('backboneStockCve values non-retired physical devices at landed cost without altering total invested', async () => {
    // Modelo dividido: landed 6000/unid, 5 em maos, com 2 unidades fisicas operacionais.
    const backboneCatalogId = db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total)
                VALUES ('cpe', 'TL-S5-5KM', 5500, 300, 200, 0, 5)`).run().lastInsertRowid;
    // Segundo modelo: landed 1500/unid, 4 em maos, com 1 unidade operacional.
    const clientCatalogId = db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total)
                VALUES ('cpe', 'CPE cliente', 1200, 200, 100, 0, 4)`).run().lastInsertRowid;
    db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name, status)
      VALUES (?, 'TL Norte', 'active'),
             (?, 'TL Sul', 'maintenance'),
             (?, 'TL aposentado', 'retired'),
             (?, 'CPE operacional', 'active')
    `).run(backboneCatalogId, backboneCatalogId, backboneCatalogId, clientCatalogId);
    // As compras que puseram este stock em casa.
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'entrada', 5, 6000)`).run(backboneCatalogId);
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'entrada', 4, 1500)`).run(clientCatalogId);

    const response = await app.inject({ method: 'GET', url: '/api/investments' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { totals: { backboneStockCve: number; totalInvestedCve: number } };
    // backbone: 2 × 6000 + 1 × 1500 = 13500; a unidade aposentada nao conta.
    expect(payload.totals.backboneStockCve).toBe(13500);
    // total investido conta as compras todas: 5×6000 + 4×1500 = 36000.
    expect(payload.totals.totalInvestedCve).toBe(36000);
  });

  test('lucro acumulado da empresa = recebido − investido (infra+stock) − despesas', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone) VALUES ('C001', 'Cliente Lucro', '5550001')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve) VALUES (?, 5000)`).run(clientId).lastInsertRowid as number;
    // Faturacao recebida: 5000 pago (+ um pendente que NAO conta).
    insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-04', 5000, '2026-04-10', 'paid')`, clientId, serviceId);
    insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-05', 5000, '2026-05-10', 'pending')`, clientId, serviceId);
    // Investido na infraestrutura: 3000 (sem stock neste teste).
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve, status) VALUES ('Torre', 'infraestrutura', '2026-05-01', '2026-05', 3000, 'ativo')`).run();
    // Despesas: 800.
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month) VALUES ('infraestrutura', 'Aluguer', 800, '2026-05-05', '2026-05')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { totals: { totalReceivedCve: number; companyAccumulatedProfitCve: number } };
    expect(payload.totals.totalReceivedCve).toBe(5000);
    // 5000 recebido − 3000 investido − 800 despesas = 1200
    expect(payload.totals.companyAccumulatedProfitCve).toBe(1200);
  });

  test('uses expenses created through the expenses module API in profitability calculations', async () => {
    const investmentId = db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Zona despesas API', 'zona', '2026-05-01', '2026-05', 20000, 4, 4, 'ativo', 16000, 0)`).run().lastInsertRowid as number;

    const sharedExpense = await app.inject({
      method: 'POST',
      url: '/api/expenses',
      payload: {
        category: 'banda_internet',
        description: 'Upstream registado em Despesas',
        amountCve: 4000,
        expenseDate: '2026-05-10'
      }
    });
    expect(sharedExpense.statusCode).toBe(201);

    const directExpense = await app.inject({
      method: 'POST',
      url: '/api/expenses',
      payload: {
        category: 'infraestrutura',
        description: 'Torre alocada em Despesas',
        amountCve: 2500,
        expenseDate: '2026-05-12',
        investmentId
      }
    });
    expect(directExpense.statusCode).toBe(201);

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      totals: { totalCostCve: number; totalExpensesCve: number; totalInvestedCve: number };
      companyOpexShare: { totalExpensesCve: number; totalAllocatedCve: number; totalUnallocatedCve: number };
      rows: Array<{ imputedMonthlyOpexCve: number; directAllocatedOpexCve: number; effectiveMonthlyOpexCve: number; monthlyNetProfitCve: number }>;
    };

    expect(payload.totals).toMatchObject({
      totalCostCve: 20000,
      totalExpensesCve: 6500,
      // "Total investido" = stock comprado (0 aqui) + investimentos manuais (20000)
      totalInvestedCve: 20000
    });
    expect(payload.companyOpexShare).toMatchObject({
      totalExpensesCve: 6500,
      totalAllocatedCve: 2500,
      totalUnallocatedCve: 4000
    });
    const row = payload.rows[0];
    expect(row.imputedMonthlyOpexCve).toBe(4000);
    expect(row.directAllocatedOpexCve).toBe(2500);
    expect(row.effectiveMonthlyOpexCve).toBe(6500);
    expect(row.monthlyNetProfitCve).toBe(9500);
  });

  test('skips OPEX rateio when no installed clients are active', async () => {
    // Only planned investments with installed=0 → denominator is 0, imputed=0.
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Futuro projecto', 'expansao', '2026-05-01', '2026-05', 50000, 20, 0, 'planeado', 0, 0)`).run();
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('outros', 'Despesa solta', 5000, '2026-05-01', '2026-05')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    const body = response.json() as {
      rows: Array<{ imputedMonthlyOpexCve: number }>;
      companyOpexShare: { totalInstalledActive: number; opexPerClientPerMonth: number };
      alerts: Array<{ severity: string; message: string }>;
    };
    expect(body.companyOpexShare.totalInstalledActive).toBe(0);
    expect(body.companyOpexShare.opexPerClientPerMonth).toBe(0);
    expect(body.rows[0].imputedMonthlyOpexCve).toBe(0);
    expect(body.alerts.some((a) => a.message.toLowerCase().includes('rateio'))).toBe(true);
  });

  test('direct OPEX allocation via investment_id bypasses the pool', async () => {
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Backbone', 'infraestrutura', '2026-05-01', '2026-05', 60000, 10, 6, 'ativo', 30000, 0)`).run();
    const targetId = db.prepare(`INSERT INTO investments
                (name, type, zone, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Edge zona', 'zona', 'Palmarejo', '2026-05-01', '2026-05', 20000, 4, 4, 'ativo', 16000, 0)`).run().lastInsertRowid as number;

    // Aluguer de torre alocado 100% ao "Edge zona". Não entra no rateio.
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month, investment_id)
                VALUES ('infraestrutura', 'Aluguer torre Palmarejo', 6000, '2026-05-01', '2026-05', ?)`).run(targetId);
    // OPEX não-alocado para o pool: 4000/mês.
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Maio', 4000, '2026-05-10', '2026-05')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    const body = response.json() as {
      rows: Array<{ name: string; imputedMonthlyOpexCve: number; directAllocatedOpexCve: number; effectiveMonthlyOpexCve: number }>;
      companyOpexShare: { totalAllocatedCve: number; totalUnallocatedCve: number; opexPerClientPerMonth: number };
    };

    // opexPerClient = unallocatedAvg / installed = 4000 / (6+4) = 400
    expect(body.companyOpexShare.opexPerClientPerMonth).toBe(400);
    expect(body.companyOpexShare.totalAllocatedCve).toBe(6000);
    expect(body.companyOpexShare.totalUnallocatedCve).toBe(4000);

    const edge = body.rows.find((r) => r.name === 'Edge zona')!;
    expect(edge.directAllocatedOpexCve).toBe(6000);
    expect(edge.imputedMonthlyOpexCve).toBe(1600); // 4 × 400
    expect(edge.effectiveMonthlyOpexCve).toBe(7600);

    const bb = body.rows.find((r) => r.name === 'Backbone')!;
    expect(bb.directAllocatedOpexCve).toBe(0);
    expect(bb.imputedMonthlyOpexCve).toBe(2400); // 6 × 400
    expect(bb.effectiveMonthlyOpexCve).toBe(2400);
  });

  test('actualMonthlyRevenue derives from paid payments of the linked client', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status)
                                 VALUES ('CLT-VIP', 'VIP', 'active')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 5000, 10, 'active')`).run(clientId);
    const serviceId = (db.prepare(`SELECT id FROM services WHERE client_id = ?`).get(clientId) as { id: number }).id;
    insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                VALUES (?, ?, '2026-03', 5000, '2026-03-10', '2026-03-10', 'paid')`, clientId, serviceId);
    insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                VALUES (?, ?, '2026-04', 5000, '2026-04-10', '2026-04-10', 'paid')`, clientId, serviceId);

    db.prepare(`INSERT INTO investments
                (name, type, client_id, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Instalacao VIP', 'cliente', ?, '2026-03-01', '2026-03', 8000, 1, 1, 'ativo', 3000)`)
      .run(clientId);

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-03' });
    const row = (response.json() as { rows: Array<{ actualMonthlyRevenueCve: number; revenueSource: string; revenueVarianceCve: number; monthlyNetProfitCve: number }> }).rows[0];

    expect(row.actualMonthlyRevenueCve).toBe(5000); // média dos 2 paid
    expect(row.revenueSource).toBe('client');
    expect(row.revenueVarianceCve).toBe(2000); // 5000 actual - 3000 expected
    // monthlyNetProfit uses ACTUAL revenue (5000) not expected
    expect(row.monthlyNetProfitCve).toBe(5000);
  });

  test('global-share usa só o pool NÃO-atribuído (sem dupla contagem de receita)', async () => {
    // Cliente A ligado a um investimento; cliente B sem ligação.
    const clientA = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-A', 'Ligado', 'active')`).run().lastInsertRowid as number;
    const clientB = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-B', 'Solto', 'active')`).run().lastInsertRowid as number;
    const svcA = db.prepare(`INSERT INTO services (client_id, monthly_value_cve) VALUES (?, 5000)`).run(clientA).lastInsertRowid as number;
    const svcB = db.prepare(`INSERT INTO services (client_id, monthly_value_cve) VALUES (?, 4000)`).run(clientB).lastInsertRowid as number;
    insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                VALUES (?, ?, '2026-03', 5000, '2026-03-10', 'paid')`, clientA, svcA);
    insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                VALUES (?, ?, '2026-03', 4000, '2026-03-10', 'paid')`, clientB, svcB);
    insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                VALUES (?, ?, '2026-04', 4000, '2026-04-10', 'paid')`, clientB, svcB);

    db.prepare(`INSERT INTO investments
                (name, type, client_id, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Ligado', 'cliente', ?, '2026-03-01', '2026-03', 8000, 1, 1, 'ativo', 3000)`).run(clientA);
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Solto', 'infraestrutura', '2026-03-01', '2026-03', 8000, 4, 4, 'ativo', 3000)`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-03' });
    const body = response.json() as { rows: Array<{ name: string; actualMonthlyRevenueCve: number; revenueSource: string }> };
    const linked = body.rows.find((r) => r.name === 'Ligado')!;
    const unlinked = body.rows.find((r) => r.name === 'Solto')!;

    expect(linked.revenueSource).toBe('client');
    expect(linked.actualMonthlyRevenueCve).toBe(5000);
    // Pool não-atribuído = (13000 total − 5000 do cliente A) / 2 meses = 4000.
    // O "Solto" é a única base instalada não-ligada → recebe 100% do pool.
    // (Antes: 13000/2 × 4/5 = 5200 — receita do A contada duas vezes.)
    expect(unlinked.revenueSource).toBe('global-share');
    expect(unlinked.actualMonthlyRevenueCve).toBe(4000);
  });

  test('OPEX direto de zona partilhada divide-se entre os investimentos (sem dupla contagem)', async () => {
    db.prepare(`INSERT INTO investments
                (name, type, zone, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Norte A', 'zona', 'Norte', '2026-05-01', '2026-05', 10000, 2, 2, 'ativo', 8000)`).run();
    db.prepare(`INSERT INTO investments
                (name, type, zone, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Norte B', 'zona', 'Norte', '2026-05-01', '2026-05', 10000, 2, 2, 'ativo', 8000)`).run();
    // Despesa alocada à ZONA (não a um investimento): 6000/mês.
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month, zone)
                VALUES ('energia', 'Energia repetidor Norte', 6000, '2026-05-01', '2026-05', 'Norte')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    const body = response.json() as { rows: Array<{ name: string; directAllocatedOpexCve: number }>; totals: { totalDirectOpexCve: number } };

    // Cada investimento absorve metade; o agregado é a despesa real (6000),
    // não 12000 como antes do divisor.
    expect(body.rows.find((r) => r.name === 'Norte A')!.directAllocatedOpexCve).toBe(3000);
    expect(body.rows.find((r) => r.name === 'Norte B')!.directAllocatedOpexCve).toBe(3000);
    expect(body.totals.totalDirectOpexCve).toBe(6000);
  });

  test('recuperação deriva dos pagamentos reais quando há cliente ligado (não do campo manual)', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-R', 'Recuperado', 'active')`).run().lastInsertRowid as number;
    const svcId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve) VALUES (?, 5000)`).run(clientId).lastInsertRowid as number;
    for (const m of ['2026-02', '2026-03']) {
      insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                  VALUES (?, ?, ?, 5000, ?, 'paid')`, clientId, svcId, m, `${m}-10`);
    }
    const invId = db.prepare(`INSERT INTO investments
                (name, type, client_id, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, accumulated_revenue_cve)
                VALUES ('Instalacao R', 'cliente', ?, '2026-02-01', '2026-02', 8000, 1, 1, 'ativo', 5000, 0)`).run(clientId).lastInsertRowid as number;
    // Despesa direta ao investimento: entra no OPEX acumulado da recuperação.
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month, investment_id)
                VALUES ('manutencao', 'Deslocacao', 1000, '2026-03-05', '2026-03', ?)`).run(invId);

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-02' });
    const row = (response.json() as { rows: Array<{ isRecovered: boolean; accumulatedProfitCve: number; roiPct: number; accumulatedRevenueSource: string }> }).rows[0];

    // 10000 pagos − 1000 OPEX direto − 8000 capital = 1000 → recuperado,
    // apesar de accumulated_revenue_cve manual estar a 0 (antes: −100% ROI
    // e "não recuperado" para sempre até alguém atualizar o campo à mão).
    expect(row.accumulatedRevenueSource).toBe('payments');
    expect(row.accumulatedProfitCve).toBe(1000);
    expect(row.isRecovered).toBe(true);
    expect(row.roiPct).toBeCloseTo(12.5, 3);
  });

  test('médias por span de calendário: meses vazios no meio contam (run-rate não inflaciona)', async () => {
    const c1 = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-S1', 'S1', 'active')`).run().lastInsertRowid as number;
    const c2 = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-S2', 'S2', 'active')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 3000, 'active')`).run(c1);
    db.prepare(`INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 3000, 'active')`).run(c2);

    // Despesas em janeiro e abril — fevereiro/março vazios TÊM de contar:
    // span 01..04 = 4 meses → 6000/4 = 1500 (por "meses com registos" dava 3000).
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Jan', 3000, '2026-01-10', '2026-01')`).run();
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Abr', 3000, '2026-04-10', '2026-04')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments' });
    const share = (response.json() as { companyOpexShare: { avgMonthlyUnallocated: number; opexPerClientPerMonth: number; rateioDenominator: number } }).companyOpexShare;

    expect(share.avgMonthlyUnallocated).toBe(1500);
    // Denominador = serviços ativos REAIS (2), não installed_clients manual.
    expect(share.rateioDenominator).toBe(2);
    expect(share.opexPerClientPerMonth).toBe(750);
  });

  test('timeline de investimento sem cliente/zona usa o global-share por mês e OPEX real do mês', async () => {
    const clientB = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-GS', 'Solto Pagador', 'active')`).run().lastInsertRowid as number;
    const svcB = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 4000, 'active')`).run(clientB).lastInsertRowid as number;
    for (const m of ['2026-03', '2026-04']) {
      insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                  VALUES (?, ?, ?, 4000, ?, 'paid')`, clientB, svcB, m, `${m}-10`);
    }
    // OPEX não-alocado só em abril: imputado aparece SÓ nesse mês da timeline
    // (antes a média de hoje era aplicada retroativamente a todos os meses).
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('energia', 'Energia Abr', 1000, '2026-04-05', '2026-04')`).run();

    const invId = db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Solto', 'infraestrutura', '2026-03-01', '2026-03', 6000, 2, 2, 'ativo', 4000)`).run().lastInsertRowid as number;

    const response = await app.inject({ method: 'GET', url: `/api/investments/${invId}/timeline` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { points: Array<{ month: string; paidRevenueCve: number; imputedOpexCve: number }>; recoveredAt: string | null };

    // Único investimento não-ligado → recebe 100% do pool não-atribuído.
    // (Antes: receita 0 em todos os meses → "nunca recupera" no gráfico.)
    const march = body.points.find((p) => p.month === '2026-03')!;
    const april = body.points.find((p) => p.month === '2026-04')!;
    expect(march.paidRevenueCve).toBe(4000);
    expect(march.imputedOpexCve).toBe(0);
    expect(april.paidRevenueCve).toBe(4000);
    expect(april.imputedOpexCve).toBe(2000); // 1000 do mês / 1 serviço ativo × 2 instalados
    // 4000 + (4000−2000) = 6000 = capital → recupera em abril.
    expect(body.recoveredAt).toBe('2026-04');
  });

  test('GET /api/investments/:id/timeline returns monthly cumulative profit and recovery month', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-T1', 'Cliente Timeline', 'active')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 5000, 10, 'active')`).run(clientId);
    const serviceId = (db.prepare('SELECT id FROM services WHERE client_id = ?').get(clientId) as { id: number }).id;
    // Pago em 4 meses consecutivos.
    for (const m of ['2026-02', '2026-03', '2026-04', '2026-05']) {
      insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                  VALUES (?, ?, ?, 5000, ?, ?, 'paid')`, clientId, serviceId, m, `${m}-10`, `${m}-10`);
    }
    const id = db.prepare(`INSERT INTO investments
                (name, type, client_id, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Instalacao timeline', 'cliente', ?, '2026-02-01', '2026-02', 10000, 1, 1, 'ativo', 5000)`).run(clientId).lastInsertRowid as number;

    const response = await app.inject({ method: 'GET', url: `/api/investments/${id}/timeline` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { points: Array<{ month: string; paidRevenueCve: number; cumulativeProfitCve: number }>; recoveredAt: string | null; monthsToRecovery: number | null };
    expect(body.points.length).toBeGreaterThanOrEqual(4);
    expect(body.points[0].paidRevenueCve).toBe(5000); // 2026-02
    // Lucro acumulado >= 0 a partir do 2º mês (5000+5000-10000 = 0).
    expect(body.recoveredAt).toBe('2026-03');
    expect(body.monthsToRecovery).toBe(2);
  });

  test('GET /api/investments/:id/timeline 404 when investment does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/investments/9999/timeline' });
    expect(response.statusCode).toBe(404);
  });

  test('alerts surface per-investment danger when monthly profit is negative', async () => {
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve, monthly_operational_cost_cve)
                VALUES ('Cliente caro', 'cliente', '2026-05-01', '2026-05', 100000, 1, 1, 'ativo', 1000, 9000)`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    const body = response.json() as { alerts: Array<{ severity: string; message: string; target?: { kind: string; name: string } }> };
    const danger = body.alerts.find((a) => a.severity === 'danger' && a.target?.kind === 'investment');
    expect(danger).toBeDefined();
    expect(danger!.target!.name).toBe('Cliente caro');
    expect(danger!.message.toLowerCase()).toContain('lucro');
  });

  test('associação exata a vários clientes: receita do conjunto, com divisão por sharers', async () => {
    // Antena de transmissão que serve os clientes A e B; C fica de fora.
    const ids: number[] = [];
    for (const code of ['CLT-MA', 'CLT-MB', 'CLT-MC']) {
      const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')`)
        .run(code, `Cliente ${code}`).lastInsertRowid as number;
      const svcId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 4000, 'active')`)
        .run(clientId).lastInsertRowid as number;
      insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                  VALUES (?, ?, '2026-03', 4000, '2026-03-10', 'paid')`, clientId, svcId);
      ids.push(clientId);
    }
    const [a, b, c] = ids;

    const create = await app.inject({
      method: 'POST',
      url: '/api/investments',
      payload: {
        name: 'Antena Norte',
        type: 'infraestrutura',
        clientIds: [a, b],
        investmentDate: '2026-03-01',
        targetClients: 2,
        installedClients: 2,
        expectedMonthlyRevenueCve: 0,
        items: [{ itemType: 'antena', itemName: 'Setorial 5GHz', quantity: 1, unitCostCve: 6000 }]
      }
    });
    expect(create.statusCode).toBe(201);
    const antennaId = create.json().id as number;

    const list = await app.inject({ method: 'GET', url: '/api/investments' });
    const row = (list.json() as { rows: Array<{ id: number; actualMonthlyRevenueCve: number; revenueSource: string; accumulatedProfitCve: number; isRecovered: boolean; clients: Array<{ id: number }> }> })
      .rows.find((r) => r.id === antennaId)!;

    // Receita = A + B (8000), C não conta; recuperação: 8000 − 6000 = 2000.
    expect(row.clients.map((cl) => cl.id).sort()).toEqual([a, b].sort());
    expect(row.revenueSource).toBe('client');
    expect(row.actualMonthlyRevenueCve).toBe(8000);
    expect(row.accumulatedProfitCve).toBe(2000);
    expect(row.isRecovered).toBe(true);

    // Segundo investimento a reclamar o cliente A: a receita de A divide-se.
    db.prepare(`INSERT INTO investments (name, type, client_id, investment_date, reference_month, total_cost_cve,
                target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Instalacao A', 'cliente', ?, '2026-03-01', '2026-03', 1000, 1, 1, 'ativo', 0)`).run(a);
    const after = await app.inject({ method: 'GET', url: '/api/investments' });
    const antenna = (after.json() as { rows: Array<{ id: number; actualMonthlyRevenueCve: number }> })
      .rows.find((r) => r.id === antennaId)!;
    // A: 4000/2 = 2000 + B: 4000 = 6000 — sem dupla contagem entre investimentos.
    expect(antenna.actualMonthlyRevenueCve).toBe(6000);

    // Timeline usa a mesma atribuição.
    const timeline = await app.inject({ method: 'GET', url: `/api/investments/${antennaId}/timeline` });
    const march = (timeline.json() as { points: Array<{ month: string; paidRevenueCve: number }> })
      .points.find((p) => p.month === '2026-03')!;
    expect(march.paidRevenueCve).toBe(6000);

    // PUT substitui o conjunto.
    const update = await app.inject({
      method: 'PUT',
      url: `/api/investments/${antennaId}`,
      payload: {
        name: 'Antena Norte',
        type: 'infraestrutura',
        clientIds: [c],
        investmentDate: '2026-03-01',
        targetClients: 2,
        installedClients: 2,
        expectedMonthlyRevenueCve: 0,
        items: [{ itemType: 'antena', itemName: 'Setorial 5GHz', quantity: 1, unitCostCve: 6000 }]
      }
    });
    expect(update.statusCode).toBe(200);
    const junction = db.prepare('SELECT client_id AS clientId FROM investment_clients WHERE investment_id = ?').all(antennaId) as Array<{ clientId: number }>;
    expect(junction.map((j) => j.clientId)).toEqual([c]);
  });

  test('alerta quando o estado manual contradiz a recuperação calculada', async () => {
    // Recuperado nos números (pagamentos > capital) mas estado ainda 'ativo'.
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-M', 'Mismatch', 'active')`).run().lastInsertRowid as number;
    const svcId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 5000, 'active')`).run(clientId).lastInsertRowid as number;
    for (const m of ['2026-02', '2026-03']) {
      insertPayment(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                  VALUES (?, ?, ?, 5000, ?, 'paid')`, clientId, svcId, m, `${m}-10`);
    }
    db.prepare(`INSERT INTO investments
                (name, type, client_id, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Ja recuperou', 'cliente', ?, '2026-02-01', '2026-02', 6000, 1, 1, 'ativo', 5000)`).run(clientId);
    // Estado diz recuperado, números dizem que não (sem pagamentos, capital alto).
    db.prepare(`INSERT INTO investments
                (name, type, investment_date, reference_month, total_cost_cve,
                 target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Otimista', 'infraestrutura', '2026-02-01', '2026-02', 90000, 5, 0, 'recuperado', 0)`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments' });
    const alerts = (response.json() as { alerts: Array<{ severity: string; message: string; target?: { name: string } }> }).alerts;

    const sync = alerts.find((a) => a.target?.name === 'Ja recuperou' && a.severity === 'info');
    expect(sync).toBeDefined();
    expect(sync!.message).toContain('atualiza o estado');

    const optimist = alerts.find((a) => a.target?.name === 'Otimista' && a.message.includes('capital por recuperar'));
    expect(optimist).toBeDefined();
    expect(optimist!.severity).toBe('warning');
  });

  test('GET /api/investments/report.pdf returns a PDF buffer', async () => {
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve, target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Backbone PDF', 'infraestrutura', '2026-05-01', '2026-05', 12000, 5, 3, 'ativo', 8000)`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments/report.pdf' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(String(response.headers['content-disposition'])).toContain('attachment');
    expect(response.rawPayload.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(response.rawPayload.length).toBeGreaterThan(800);
  });

  test('GET /api/investments/report.xlsx returns an XLSX buffer', async () => {
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve, target_clients, installed_clients, status, expected_monthly_revenue_cve)
                VALUES ('Edge zona XLSX', 'zona', '2026-05-01', '2026-05', 30000, 10, 6, 'ativo', 18000)`).run();
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Maio', 8000, '2026-05-15', '2026-05')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments/report.xlsx' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // XLSX = ZIP archive → starts with "PK".
    expect(response.rawPayload.slice(0, 2).toString('ascii')).toBe('PK');
    expect(response.rawPayload.length).toBeGreaterThan(2000);
  });

  test('dashboard summary aggregates investment cost per month', async () => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve)
                VALUES ('Backbone corrente', 'infraestrutura', ?, ?, 15000)`).run(`${currentMonth}-01`, currentMonth);
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve)
                VALUES ('Instalacao corrente', 'cliente', ?, ?, 5000)`).run(`${currentMonth}-02`, currentMonth);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const currentPoint = body.revenueByMonth.find(
      (p: { referenceMonth: string }) => p.referenceMonth === currentMonth
    );
    expect(currentPoint).toBeDefined();
    expect(currentPoint.expenseCve).toBe(20000);
  });
});

/**
 * A rentabilidade le `payment_receipts`, nao faturas fechadas. Estes testes
 * exercem o caminho real do dinheiro (POST /pay, /void, /apply-credit) porque
 * e ai que as tres regras vivem: parcial conta, anulado nao conta, e credito
 * nao conta duas vezes.
 */
describe('lucro em regime de caixa', () => {
  function faturar(amountCve: number, referenceMonth: string, dueDate: string): number {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone) VALUES ('C900', 'Cliente Caixa', '5559000')`)
      .run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve) VALUES (?, ?)`)
      .run(clientId, amountCve).lastInsertRowid as number;
    return db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(clientId, serviceId, referenceMonth, amountCve, dueDate).lastInsertRowid as number;
  }

  async function caixaAcumulada(): Promise<number> {
    const res = await app.inject({ method: 'GET', url: '/api/investments' });
    expect(res.statusCode).toBe(200);
    return res.json().totals.companyAccumulatedProfitCve;
  }

  test('um recebimento parcial pesa o que entrou, nao zero nem o total da fatura', async () => {
    const paymentId = faturar(50000, '2026-04', '2026-04-10');

    const pay = await app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2026-04-15', amountCve: 10000 }
    });
    expect(pay.statusCode).toBe(200);
    // A fatura continua aberta — e a caixa ja tem os 10.000$.
    expect(db.prepare(`SELECT status FROM payments WHERE id = ?`).get(paymentId)).toEqual({ status: 'pending' });
    expect(await caixaAcumulada()).toBe(10000);

    // O resto entra quando entrar, e ai sim a fatura fecha.
    await app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2026-05-02' }
    });
    expect(await caixaAcumulada()).toBe(50000);
  });

  test('recibo anulado deixa de ser caixa', async () => {
    const paymentId = faturar(5000, '2026-04', '2026-04-10');
    const pay = await app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2026-04-15' }
    });
    const receiptId = pay.json().receipt.id as number;
    expect(await caixaAcumulada()).toBe(5000);

    const voided = await app.inject({
      method: 'POST', url: `/api/receipts/${receiptId}/void`,
      payload: { reason: 'Cheque devolvido pelo banco' }
    });
    expect(voided.statusCode).toBe(200);
    expect(await caixaAcumulada()).toBe(0);
  });

  test('liquidar por conta corrente nao conta o mesmo dinheiro duas vezes', async () => {
    // Paga 6.000$ numa fatura de 5.000$: 5.000$ de recibo, 1.000$ de credito.
    const primeira = faturar(5000, '2026-04', '2026-04-10');
    const pay = await app.inject({
      method: 'POST', url: `/api/payments/${primeira}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2026-04-15', amountCve: 6000 }
    });
    expect(pay.json().creditAddedCve).toBe(1000);
    expect(await caixaAcumulada()).toBe(5000);

    // O credito abate numa fatura seguinte: dinheiro nenhum entra hoje.
    const clientId = db.prepare(`SELECT client_id AS id FROM payments WHERE id = ?`).get(primeira) as { id: number };
    const serviceId = db.prepare(`SELECT service_id AS id FROM payments WHERE id = ?`).get(primeira) as { id: number };
    const segunda = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-05', 1000, '2026-05-10', 'pending')
    `).run(clientId.id, serviceId.id).lastInsertRowid as number;
    const applied = await app.inject({ method: 'POST', url: `/api/payments/${segunda}/apply-credit`, payload: {} });
    expect(applied.statusCode).toBe(200);
    expect(db.prepare(`SELECT status FROM payments WHERE id = ?`).get(segunda)).toEqual({ status: 'paid' });
    // Continua 5.000$: os 1.000$ ja tinham entrado em abril.
    expect(await caixaAcumulada()).toBe(5000);
  });

  test('a receita cai no mes em que o dinheiro entrou, nao no da competencia', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone) VALUES ('C901', 'Cliente Atrasado', '5559001')`)
      .run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 5000, 'active')`)
      .run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-03', 5000, '2026-03-10', 'pending')
    `).run(clientId, serviceId).lastInsertRowid as number;
    const invId = db.prepare(`
      INSERT INTO investments (name, type, client_id, investment_date, reference_month, total_cost_cve,
                               target_clients, installed_clients, status)
      VALUES ('Antena atrasada', 'infraestrutura', ?, '2026-03-01', '2026-03', 20000, 1, 1, 'ativo')
    `).run(clientId).lastInsertRowid as number;

    // Competencia de marco, dinheiro entregue em maio.
    await app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2026-05-20' }
    });

    const res = await app.inject({ method: 'GET', url: `/api/investments/${invId}/timeline` });
    expect(res.statusCode).toBe(200);
    const points = res.json().points as Array<{ month: string; paidRevenueCve: number }>;
    const marco = points.find((p) => p.month === '2026-03');
    const maio = points.find((p) => p.month === '2026-05');
    expect(marco?.paidRevenueCve ?? 0).toBe(0);
    expect(maio?.paidRevenueCve).toBe(5000);
  });
});

describe('coerencia entre o cartao e o grafico', () => {
  test('o capital por ano soma exatamente o total investido', async () => {
    const catalogId = db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, stock_total) VALUES ('cpe', 'CPE710', 5000, 2)`)
      .run().lastInsertRowid as number;
    // Compras em dois anos civis diferentes.
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, created_at)
                VALUES (?, 'entrada', 1, 5000, '2025-04-02 09:00:00')`).run(catalogId);
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, created_at)
                VALUES (?, 'entrada', 1, 5000, '2026-02-11 09:00:00')`).run(catalogId);
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve, status)
                VALUES ('Poste', 'infraestrutura', '2026-03-01', '2026-03', 7000, 'ativo')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments' });
    const payload = response.json() as {
      totals: { totalInvestedCve: number; investedByYear: Array<{ capexCve: number }> };
    };
    // Enquanto o stock ficou fora do grafico, o cartao dizia 17.000$ e o
    // grafico 7.000$: dois numeros com o mesmo nome.
    expect(payload.totals.totalInvestedCve).toBe(17_000);
    const fromChart = payload.totals.investedByYear.reduce((sum, y) => sum + y.capexCve, 0);
    expect(fromChart).toBe(payload.totals.totalInvestedCve);
  });

  test('um item ligado ao catalogo nao soma ao capital da empresa', async () => {
    const catalogId = db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, stock_total) VALUES ('cpe', 'CPE710', 5000, 0)`)
      .run().lastInsertRowid as number;
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve)
                VALUES (?, 'entrada', 6, 5000)`).run(catalogId);
    const investmentId = db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve, status)
                VALUES ('Expansao Achada', 'zona', '2026-03-01', '2026-03', 42000, 'ativo')`)
      .run().lastInsertRowid as number;
    db.prepare(`INSERT INTO investment_items
                (investment_id, item_type, item_name, quantity, unit_cost_cve, total_cost_cve, catalog_id)
                VALUES (?, 'cpe', 'CPE710', 6, 5000, 30000, ?)`).run(investmentId, catalogId);
    db.prepare(`INSERT INTO investment_items
                (investment_id, item_type, item_name, quantity, unit_cost_cve, total_cost_cve, catalog_id)
                VALUES (?, 'mao_obra', 'Mao de obra', 1, 12000, 12000, NULL)`).run(investmentId);

    const response = await app.inject({ method: 'GET', url: '/api/investments' });
    const payload = response.json() as { totals: { totalInvestedCve: number } };
    // 30.000$ de compras + 12.000$ de mao de obra. Os seis CPE contam uma vez.
    expect(payload.totals.totalInvestedCve).toBe(42_000);
  });
});

describe('zonas mais rentaveis', () => {
  function cliente(code: string, nome: string, zona: string | null, telefone: string): number {
    return db.prepare(`INSERT INTO clients (client_code, full_name, phone, zone) VALUES (?, ?, ?, ?)`)
      .run(code, nome, telefone, zona).lastInsertRowid as number;
  }

  function recebeu(clientId: number, amountCve: number, month: string) {
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, ?, 'active')`)
      .run(clientId, amountCve).lastInsertRowid as number;
    insertPayment(
      `INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'paid')`,
      clientId, serviceId, month, amountCve, `${month}-10`, `${month}-10`
    );
  }

  test('agrupa pela zona do CLIENTE, nao pela etiqueta do investimento', async () => {
    const espia = cliente('C-E1', 'Cliente Espia', 'Espia', '5550001');
    const cruz = cliente('C-C1', 'Cliente Cruz', 'Cruz', '5550002');
    const semZona = cliente('C-S1', 'Cliente Sem Zona', null, '5550003');
    recebeu(espia, 3000, '2026-06');
    recebeu(cruz, 1000, '2026-06');
    recebeu(semZona, 500, '2026-06');

    // Um investimento etiquetado "Cruz" que reclama o cliente da Espia: a
    // etiqueta nao pode mudar em que zona a receita dele aparece.
    const create = await app.inject({
      method: 'POST',
      url: '/api/investments',
      payload: {
        name: 'Antena etiquetada Cruz', type: 'zona', zone: 'Cruz',
        investmentDate: '2026-06-01', clientIds: [espia],
        targetClients: 1, installedClients: 1,
        items: [{ itemType: 'antena', itemName: 'CPE', quantity: 1, unitCostCve: 10000 }]
      }
    });
    expect(create.statusCode).toBe(201);

    const zones = (await app.inject({ method: 'GET', url: '/api/investments' })).json().zoneSummary as
      Array<{ zone: string; clients: number; monthlyRevenueCve: number; monthlyNetProfitCve: number }>;
    expect(zones.map((z) => [z.zone, z.monthlyRevenueCve])).toEqual([
      ['Espia', 3000], ['Cruz', 1000], ['Sem zona', 500]
    ]);
    // Sem despesas nao ha OPEX: o lucro e a receita, e cada zona tem 1 servico.
    expect(zones.every((z) => z.clients === 1 && z.monthlyNetProfitCve === z.monthlyRevenueCve)).toBe(true);
  });

  test('desconta o OPEX rateado por servico ativo e a despesa fixada a zona', async () => {
    const a = cliente('C-E2', 'Espia A', 'Espia', '5550004');
    const b = cliente('C-E3', 'Espia B', 'Espia', '5550005');
    recebeu(a, 3000, '2026-06');
    recebeu(b, 3000, '2026-06');
    // 2.000$ por ratear entre 2 servicos = 1.000$/cliente; 500$ so da Espia.
    db.prepare(`INSERT INTO expenses (expense_date, reference_month, category, description, amount_cve) VALUES ('2026-06-05', '2026-06', 'infraestrutura', 'Internet', 2000)`).run();
    db.prepare(`INSERT INTO expenses (expense_date, reference_month, category, description, amount_cve, zone) VALUES ('2026-06-05', '2026-06', 'infraestrutura', 'Poste Espia', 500, 'Espia')`).run();

    const zones = (await app.inject({ method: 'GET', url: '/api/investments' })).json().zoneSummary as
      Array<{ zone: string; monthlyRevenueCve: number; monthlyOpexCve: number; monthlyNetProfitCve: number }>;
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ monthlyRevenueCve: 6000, monthlyOpexCve: 2500, monthlyNetProfitCve: 3500 });
  });

  test('meses medem-se pelo mesmo span para todas as zonas', async () => {
    const antiga = cliente('C-E4', 'Espia Antiga', 'Espia', '5550006');
    const nova = cliente('C-C2', 'Cruz Nova', 'Cruz', '5550007');
    recebeu(antiga, 1000, '2026-06');
    recebeu(antiga, 1000, '2026-07');
    recebeu(nova, 1200, '2026-07');

    const zones = (await app.inject({ method: 'GET', url: '/api/investments' })).json().zoneSummary as
      Array<{ zone: string; monthlyRevenueCve: number }>;
    // Span global = 2 meses. A Cruz, com um so mes de recibos, vale 600$/mes —
    // nao 1.200$, que era o que um span proprio por zona lhe dava.
    expect(zones.find((z) => z.zone === 'Espia')?.monthlyRevenueCve).toBe(1000);
    expect(zones.find((z) => z.zone === 'Cruz')?.monthlyRevenueCve).toBe(600);
  });
});
