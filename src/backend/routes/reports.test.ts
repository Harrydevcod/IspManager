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

type ReportSummary = {
  metrics: {
    totalClients: number;
    activeServices: number;
    overduePayments: number;
    overdueAmountCve: number;
    paidAmountCve: number;
    stockValueCve: number;
  };
  revenueByMonth: Array<{ referenceMonth: string; paidCve: number; pendingCve: number; payments: number }>;
  overdueClients: Array<{
    clientName: string;
    clientCode: string;
    phone: string | null;
    payments: number;
    amountCve: number;
    oldestDueDate: string;
  }>;
  stockRows: Array<{ type: string; brand: string; model: string; stockTotal: number; valueCve: number }>;
  pagination: {
    view: 'revenue' | 'overdue' | 'stock';
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-reports-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
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
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

function seedBasicScenario() {
  const insertClient = db.prepare(`
    INSERT INTO clients (client_code, full_name, phone, status)
    VALUES (?, ?, ?, ?)
  `);
  const ana = insertClient.run('CLT-0001', 'Ana Lima', '9111111', 'active').lastInsertRowid as number;
  const bruno = insertClient.run('CLT-0002', 'Bruno Costa', '9222222', 'active').lastInsertRowid as number;
  insertClient.run('CLT-0003', 'Carla Dias', '9333333', 'cancelled');

  const planId = db.prepare(`
    INSERT INTO internet_plans (name, download_speed, upload_speed, connection_type, monthly_price_cve)
    VALUES ('Plano 50', '50', '25', 'fibra', 4500)
  `).run().lastInsertRowid as number;

  const insertService = db.prepare(`
    INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  const anaService = insertService.run(ana, planId, 4500, 10, 'active').lastInsertRowid as number;
  const brunoService = insertService.run(bruno, planId, 4500, 10, 'active').lastInsertRowid as number;

  const insertPayment = db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // A paga leva o recibo que a saldou: o recebido le `payment_receipts`, que e
  // onde um recebimento parcial existe.
  const anaPaid = insertPayment.run(ana, anaService, '2026-04', 4500, '2026-04-10', '2026-04-10', 'paid').lastInsertRowid as number;
  db.prepare(`
    INSERT INTO payment_receipts (
      payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date
    ) VALUES (?, 4500, '2026-04-10', 'numerario', 'cash', 'RC-TEST-1', '2026-04-10')
  `).run(anaPaid);
  insertPayment.run(ana, anaService, '2026-05', 4500, '2026-05-10', null, 'pending');
  insertPayment.run(bruno, brunoService, '2026-03', 4500, '2026-03-10', null, 'overdue');
  insertPayment.run(bruno, brunoService, '2026-02', 4500, '2026-02-10', null, 'overdue');

  const insertEquipment = db.prepare(`
    INSERT INTO equipment_catalog (type, brand, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertEquipment.run('cpe', 'Mikrotik', 'hAP ax2', 5000, 200, 100, 50, 10, 1);
  insertEquipment.run('router', 'TP-Link', 'Archer', 3000, 100, 50, 25, 2, 1);
  insertEquipment.run('antena', 'Ubiquiti', 'Old', 4000, 0, 0, 0, 0, 0); // inactive — excluded
}

describe('GET /api/reports/summary', () => {
  test('aggregates totals across clients, services, payments and stock', async () => {
    seedBasicScenario();

    const response = await app.inject({ method: 'GET', url: '/api/reports/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ReportSummary;

    expect(body.metrics.totalClients).toBe(3);
    expect(body.metrics.activeServices).toBe(2);
    // Os dois da Bruno mais o pendente da Ana, cuja data de vencimento já
    // passou — vencido é a data, não o estado ter sido marcado à mão.
    expect(body.metrics.overduePayments).toBe(3);
    expect(body.metrics.overdueAmountCve).toBe(13500);
    expect(body.metrics.paidAmountCve).toBe(4500);
    // 10 * (5000+200+100+50) + 2 * (3000+100+50+25) = 53500 + 6350 = 59850
    expect(body.metrics.stockValueCve).toBe(59850);
  });

  test('returns revenueByMonth ordered desc by reference_month', async () => {
    seedBasicScenario();
    const response = await app.inject({ method: 'GET', url: '/api/reports/summary' });
    const body = response.json() as ReportSummary;

    const months = body.revenueByMonth.map((row) => row.referenceMonth);
    expect(months).toEqual(['2026-05', '2026-04', '2026-03', '2026-02']);

    const april = body.revenueByMonth.find((r) => r.referenceMonth === '2026-04')!;
    expect(april.paidCve).toBe(4500);
    expect(april.pendingCve).toBe(0);
    expect(april.payments).toBe(1);

    const may = body.revenueByMonth.find((r) => r.referenceMonth === '2026-05')!;
    expect(may.paidCve).toBe(0);
    expect(may.pendingCve).toBe(4500);
  });

  test('paginates and filters report rows by payment date range', async () => {
    seedBasicScenario();
    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/summary?view=revenue&page=1&pageSize=1&dateFrom=2026-02-01&dateTo=2026-03-31'
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ReportSummary;

    expect(body.pagination).toEqual({
      view: 'revenue',
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2
    });
    expect(body.revenueByMonth).toHaveLength(1);
    expect(body.revenueByMonth[0].referenceMonth).toBe('2026-03');
  });

  test('overdueClients groups by client and stockRows excludes inactive equipment ordered by stock asc', async () => {
    seedBasicScenario();
    const response = await app.inject({ method: 'GET', url: '/api/reports/summary' });
    const body = response.json() as ReportSummary;

    expect(body.overdueClients).toHaveLength(2);
    expect(body.overdueClients.map((row) => row.clientName)).toContain('Ana Lima');
    expect(body.overdueClients.find((row) => row.clientName === 'Bruno Costa')).toMatchObject({
      clientName: 'Bruno Costa',
      clientCode: 'CLT-0002',
      phone: '9222222',
      payments: 2,
      amountCve: 9000,
      oldestDueDate: '2026-02-10'
    });

    expect(body.stockRows.map((r) => r.model)).toEqual(['Archer', 'hAP ax2']);
    expect(body.stockRows[0]).toMatchObject({ type: 'router', brand: 'TP-Link', model: 'Archer', stockTotal: 2, valueCve: 6350 });
    expect(body.stockRows.find((r) => r.model === 'Old')).toBeUndefined();
  });

  test('returns empty collections when there is no data', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports/summary' });
    const body = response.json() as ReportSummary;

    expect(body.metrics).toEqual({
      totalClients: 0,
      activeServices: 0,
      overduePayments: 0,
      overdueAmountCve: 0,
      paidAmountCve: 0,
      stockValueCve: 0
    });
    expect(body.revenueByMonth).toEqual([]);
    expect(body.overdueClients).toEqual([]);
    expect(body.stockRows).toEqual([]);
  });
});

describe('GET /api/reports/portfolio', () => {
  test('a lista e a ficha do cliente dao o mesmo numero', async () => {
    const clientId = db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, zone, status)
      VALUES ('C900', 'Cliente Carteira', '5559001', 'Achada', 'active')
    `).run().lastInsertRowid as number;
    const planId = db.prepare(`
      INSERT INTO internet_plans (name, monthly_price_cve, active) VALUES ('Base', 2500, 1)
    `).run().lastInsertRowid as number;
    const serviceId = db.prepare(`
      INSERT INTO services (client_id, plan_id, status, activation_date, monthly_value_cve)
      VALUES (?, ?, 'active', '2026-01-05', 2500)
    `).run(clientId, planId).lastInsertRowid as number;
    const catalogId = db.prepare(`
      INSERT INTO equipment_catalog (type, model, purchase_price_cve, stock_total)
      VALUES ('cpe', 'CPE710', 6000, 0)
    `).run().lastInsertRowid as number;
    db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id, start_date, ownership)
      VALUES (?, ?, '2026-01-05', 'isp')
    `).run(serviceId, catalogId);

    const list = await app.inject({ method: 'GET', url: '/api/reports/portfolio' });
    expect(list.statusCode).toBe(200);
    const payload = list.json() as {
      rows: Array<{ clientId: number; installationCostCve: number; netProfitCve: number }>;
      totals: { installedCapitalCve: number; parkUnits: number };
    };
    const row = payload.rows.find((r) => r.clientId === clientId)!;
    expect(row.installationCostCve).toBeCloseTo(6000, 6);
    expect(payload.totals.installedCapitalCve).toBeCloseTo(6000, 6);
    expect(payload.totals.parkUnits).toBe(1);

    // A ficha do cliente le da mesma funcao: os dois nao se podem separar.
    const detail = await app.inject({ method: 'GET', url: `/api/clients/${clientId}/profitability` });
    const client = detail.json() as { installationCostCve: number; netProfitCve: number };
    expect(client.installationCostCve).toBeCloseTo(row.installationCostCve, 6);
    expect(client.netProfitCve).toBeCloseTo(row.netProfitCve, 6);
  });
});
