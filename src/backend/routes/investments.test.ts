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

beforeEach(() => {
  db.prepare('DELETE FROM stock_movements').run();
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM investment_items').run();
  db.prepare('DELETE FROM investments').run();
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

  test('"Total investido" = stock comprado (em maos + consumido) + investimentos manuais', async () => {
    // Custo landed = 1200+200+100 = 1500/unid; 10 unidades em armazem.
    const catalogId = db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total)
                VALUES ('router', 'hAP ax2', 1200, 200, 100, 0, 10)`).run().lastInsertRowid as number;
    // 4 unidades ja sairam (instaladas), valorizadas ao custo landed.
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'saida', 4, 1500)`).run(catalogId);
    // Investimento manual (tabela investments) que tambem entra no total.
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve, status)
                VALUES ('Torre Achada', 'infraestrutura', '2026-05-01', '2026-05', 5000, 'ativo')`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { totals: { totalInvestedCve: number } };
    // stock: em maos 10×1500=15000 + consumido 4×1500=6000 = 21000; + investimentos 5000 = 26000
    expect(payload.totals.totalInvestedCve).toBe(26000);
  });

  test('backboneStockCve = unidades backbone × landed, modelo dividido, sem alterar total investido', async () => {
    // Modelo dividido: landed 6000/unid, 5 em maos, mas só 2 unidades sao backbone.
    db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total, backbone_qty)
                VALUES ('cpe', 'TL-S5-5KM', 5500, 300, 200, 0, 5, 2)`).run();
    // Equipamento sem backbone: landed 1500/unid, 4 em maos.
    db.prepare(`INSERT INTO equipment_catalog
                (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total, backbone_qty)
                VALUES ('cpe', 'CPE cliente', 1200, 200, 100, 0, 4, 0)`).run();

    const response = await app.inject({ method: 'GET', url: '/api/investments' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { totals: { backboneStockCve: number; totalInvestedCve: number } };
    // backbone: 2 unidades × 6000 = 12000 (as outras 3 do mesmo modelo NAO contam)
    expect(payload.totals.backboneStockCve).toBe(12000);
    // total investido conta o stock todo: 5×6000 + 4×1500 = 36000 (backbone_qty nao altera)
    expect(payload.totals.totalInvestedCve).toBe(36000);
  });

  test('lucro acumulado da empresa = recebido − investido (infra+stock) − despesas', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone) VALUES ('C001', 'Cliente Lucro', '5550001')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve) VALUES (?, 5000)`).run(clientId).lastInsertRowid as number;
    // Faturacao recebida: 5000 pago (+ um pendente que NAO conta).
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-04', 5000, '2026-04-10', 'paid')`).run(clientId, serviceId);
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-05', 5000, '2026-05-10', 'pending')`).run(clientId, serviceId);
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
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                VALUES (?, ?, '2026-03', 5000, '2026-03-10', '2026-03-10', 'paid')`).run(clientId, serviceId);
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                VALUES (?, ?, '2026-04', 5000, '2026-04-10', '2026-04-10', 'paid')`).run(clientId, serviceId);

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
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                VALUES (?, ?, '2026-03', 5000, '2026-03-10', 'paid')`).run(clientA, svcA);
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                VALUES (?, ?, '2026-03', 4000, '2026-03-10', 'paid')`).run(clientB, svcB);
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                VALUES (?, ?, '2026-04', 4000, '2026-04-10', 'paid')`).run(clientB, svcB);

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
      db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                  VALUES (?, ?, ?, 5000, ?, 'paid')`).run(clientId, svcId, m, `${m}-10`);
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
      db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                  VALUES (?, ?, ?, 4000, ?, 'paid')`).run(clientB, svcB, m, `${m}-10`);
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
      db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                  VALUES (?, ?, ?, 5000, ?, ?, 'paid')`).run(clientId, serviceId, m, `${m}-10`, `${m}-10`);
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
