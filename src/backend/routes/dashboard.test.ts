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

const TABLES_TO_CLEAR = [
  'service_events',
  'service_device_assignments',
  'client_credits',
  'payment_receipts',
  'payment_lines',
  'payments',
  'expenses',
  'investment_items',
  'investments',
  'stock_movements',
  'services',
  'internet_plans',
  'equipment_catalog',
  'app_settings',
  'clients'
];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-dashboard-test-'));
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
  for (const table of TABLES_TO_CLEAR) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

/**
 * Uma fatura paga como o motor a deixa: com o recibo que a saldou.
 *
 * O regime de caixa passou a ler `payment_receipts` (e o unico sitio onde um
 * recebimento parcial aparece), por isso semear so `status = 'paid'` descrevia
 * um estado que a aplicacao nunca produz — em producao a migracao 0052 fez o
 * mesmo ao historico.
 */
function seedPaidPayment(
  clientId: number,
  serviceId: number,
  referenceMonth: string,
  amountCve: number,
  dueDate: string,
  paymentDate: string
): number {
  const paymentId = db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
    VALUES (?, ?, ?, ?, ?, ?, 'paid')
  `).run(clientId, serviceId, referenceMonth, amountCve, dueDate, paymentDate).lastInsertRowid as number;

  db.prepare(`
    INSERT INTO payment_receipts (
      payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date
    ) VALUES (?, ?, ?, 'numerario', 'cash', ?, ?)
  `).run(paymentId, amountCve, paymentDate, `RC-TEST-${paymentId}`, paymentDate);

  return paymentId;
}

describe('GET /api/dashboard/summary', () => {
  test('returns sane zero state with empty database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toMatchObject({
      totalClients: 0,
      activeClients: 0,
      suspendedClients: 0,
      cancelledClients: 0,
      overduePayments: 0,
      pendingPayments: 0,
      lowStockModels: 0,
      activeServices: 0,
      paidMonthCve: 0,
      pendingMonthCve: 0,
      pendingPreviousCve: 0,
      paidTotalCve: 0
    });

    expect(Array.isArray(body.revenueByMonth)).toBe(true);
    expect(body.revenueByMonth).toHaveLength(12);
    body.revenueByMonth.forEach((point: { referenceMonth: string; paidCve: number; pendingCve: number }) => {
      expect(point.paidCve).toBe(0);
      expect(point.pendingCve).toBe(0);
      expect(point.referenceMonth).toMatch(/^\d{4}-\d{2}$/);
    });

    expect(Array.isArray(body.upcomingDues)).toBe(true);
    expect(body.upcomingDues).toHaveLength(0);

    expect(Array.isArray(body.criticalOverdue)).toBe(true);
    expect(body.criticalOverdue).toHaveLength(0);

    expect(Array.isArray(body.planMix)).toBe(true);
    expect(body.planMix).toHaveLength(0);

    expect(Array.isArray(body.workQueue)).toBe(true);
    expect(body.workQueue).toHaveLength(0);
  });

  test('aggregates paid revenue for the current month into paidMonthCve', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C001', 'Cliente Teste', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C001'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano A', 'fibra', 3500, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano A'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 3500, 10, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dueDate = `${currentMonth}-10`;

    seedPaidPayment(clientId.id, serviceId.id, currentMonth, 3500, dueDate, dueDate);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.paidMonthCve).toBe(3500);
    expect(body.activeServices).toBe(1);
    expect(body.planMix).toEqual([{ connectionType: 'fibra', count: 1 }]);

    expect(body.revenueByMonth[0].referenceMonth).toBe(`${now.getFullYear()}-01`);
    expect(body.revenueByMonth.at(-1)?.referenceMonth).toBe(`${now.getFullYear()}-12`);
    const currentPoint = body.revenueByMonth.find(
      (p: { referenceMonth: string }) => p.referenceMonth === currentMonth
    );
    expect(currentPoint?.paidCve).toBe(3500);
  });

  test('aggregates pending revenue for the current month into pendingMonthCve', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C003', 'Cliente Pendente', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C003'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano P', 'fibra', 4200, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano P'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 4200, 15, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dueDate = `${currentMonth}-15`;

    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, ?, 4200, ?, 'pending')
    `).run(clientId.id, serviceId.id, currentMonth, dueDate);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.pendingMonthCve).toBe(4200);
    const currentPoint = body.revenueByMonth.find(
      (p: { referenceMonth: string }) => p.referenceMonth === currentMonth
    );
    expect(currentPoint?.pendingCve).toBe(4200);
  });

  test('counts post-paid pendings due this month into pendingMonthCve (competence in closed month)', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C007', 'Cliente Pos-pago', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C007'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano PP', 'fibra', 3000, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano PP'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 3000, 10, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    // Forma real pós-paga: competência do mês fechado, vencimento no mês corrente.
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, ?, 3000, ?, 'pending')
    `).run(clientId.id, serviceId.id, previousMonth, `${currentMonth}-10`);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.pendingMonthCve).toBe(3000);
    expect(body.pendingMonthCount).toBe(1);
    expect(body.pendingPreviousCve).toBe(3000);
  });

  test('accumulates pending revenue from previous months into pendingPreviousCve', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C004', 'Cliente Backlog', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C004'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano B', 'fibra', 5000, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano B'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 5000, 5, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    // December of last year is always lexically before the current month.
    const previousMonth = `${new Date().getFullYear() - 1}-12`;
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, ?, 5000, ?, 'overdue')
    `).run(clientId.id, serviceId.id, previousMonth, `${previousMonth}-05`);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.pendingPreviousCve).toBe(5000);
    expect(body.pendingMonthCve).toBe(0);
    expect(body.pendingMonthCount).toBe(0);
  });

  test('sums all paid payments across months into paidTotalCve', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C005', 'Cliente Total', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C005'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano T', 'fibra', 2000, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano T'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 2000, 8, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const previousMonth = `${now.getFullYear() - 1}-12`;

    seedPaidPayment(clientId.id, serviceId.id, currentMonth, 2000, `${currentMonth}-08`, `${currentMonth}-08`);
    seedPaidPayment(clientId.id, serviceId.id, previousMonth, 2000, `${previousMonth}-08`, `${previousMonth}-08`);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.paidTotalCve).toBe(4000);
    expect(body.paidMonthCve).toBe(2000);
  });

  test('paidMonthCve é regime de caixa: competência antiga paga este mês conta', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C009', 'Cliente Caixa', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C009'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano X', 'fibra', 2500, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano X'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 2500, 5, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

    // Pós-pago: fatura da competência do mês fechado, paga só este mês.
    seedPaidPayment(clientId.id, serviceId.id, previousMonth, 2500, `${previousMonth}-05`, `${currentMonth}-03`);

    const body = (await app.inject({ method: 'GET', url: '/api/dashboard/summary' })).json();
    expect(body.paidMonthCve).toBe(2500);
    expect(body.paidPrevMonthCve).toBe(0);
  });

  test('conta como atraso o pendente cuja data ja passou, sem esperar pelo estado overdue', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C003', 'Cliente Vencido', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C003'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano C', 'radio', 3000, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano C'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 3000, 1, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const dueDate = tenDaysAgo.toISOString().slice(0, 10);

    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, ?, 3000, ?, 'pending')
    `).run(clientId.id, serviceId.id, dueDate.slice(0, 7), dueDate);

    const body = (await app.inject({ method: 'GET', url: '/api/dashboard/summary' })).json();
    expect(body.overduePayments).toBe(1);
  });

  test('flags critical overdue payments older than 30 days', async () => {
    db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C002', 'Cliente Atrasado', 'active')`).run();
    const clientId = db.prepare(`SELECT id FROM clients WHERE client_code = 'C002'`).get() as { id: number };
    db.prepare(`INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active) VALUES ('Plano B', 'radio', 2000, 1)`).run();
    const planId = db.prepare(`SELECT id FROM internet_plans WHERE name = 'Plano B'`).get() as { id: number };
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 2000, 1, 'active')
    `).run(clientId.id, planId.id);
    const serviceId = db.prepare(`SELECT id FROM services LIMIT 1`).get() as { id: number };

    const fortyDaysAgo = new Date();
    fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);
    const overdueDate = fortyDaysAgo.toISOString().slice(0, 10);
    const overdueMonth = overdueDate.slice(0, 7);

    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, ?, 2000, ?, 'overdue')
    `).run(clientId.id, serviceId.id, overdueMonth, overdueDate);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.criticalOverdue).toHaveLength(1);
    expect(body.criticalOverdue[0]).toMatchObject({
      clientName: 'Cliente Atrasado',
      clientCode: 'C002',
      amountCve: 2000
    });
    expect(body.criticalOverdue[0].daysOverdue).toBeGreaterThanOrEqual(39);
  });
});
