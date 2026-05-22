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
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM investment_items').run();
  db.prepare('DELETE FROM investments').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
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
    expect(body.rows[0].annualRoiPct).toBeCloseTo(1284.615, 2);

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
      alerts: string[];
    };
    expect(body.companyOpexShare.totalInstalledActive).toBe(0);
    expect(body.companyOpexShare.opexPerClientPerMonth).toBe(0);
    expect(body.rows[0].imputedMonthlyOpexCve).toBe(0);
    expect(body.alerts.some((a) => a.toLowerCase().includes('rateio'))).toBe(true);
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
