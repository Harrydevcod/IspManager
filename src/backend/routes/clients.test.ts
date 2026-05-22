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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-clients-test-'));
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
  db.prepare('DELETE FROM work_orders').run();
  db.prepare('DELETE FROM service_events').run();
  db.prepare('DELETE FROM service_device_assignments').run();
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM investment_items').run();
  db.prepare('DELETE FROM investments').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM stock_movements').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM app_settings').run();
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

describe('POST /api/clients/bulk', () => {
  test('inserts new rows and auto-generates clientCode when missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/bulk',
      payload: {
        rows: [
          { fullName: 'Maria Tavares', phone: '9111111' },
          { fullName: 'Joao Silva', nif: '123456789', email: 'joao@example.com' }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ received: 2, inserted: 2, skipped: 0, errors: 0 });
    expect(body.inserted).toHaveLength(2);
    expect(body.inserted[0].clientCode).toMatch(/^CLT-\d{4}$/);

    const stored = db.prepare('SELECT full_name, phone, nif, email FROM clients ORDER BY id').all();
    expect(stored).toEqual([
      { full_name: 'Maria Tavares', phone: '9111111', nif: null, email: null },
      { full_name: 'Joao Silva', phone: null, nif: '123456789', email: 'joao@example.com' }
    ]);
  });

  test('skips duplicates by clientCode, NIF, and phone without aborting the batch', async () => {
    db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, nif, status)
      VALUES ('CLT-EXIST', 'Existente', '9999999', '987654321', 'active')
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/bulk',
      payload: {
        rows: [
          { fullName: 'Novo Cliente', phone: '9000001' },
          { fullName: 'Dup Code', clientCode: 'CLT-EXIST' },
          { fullName: 'Dup NIF', nif: '987654321' },
          { fullName: 'Dup Phone', phone: '9999999' }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ received: 4, inserted: 1, skipped: 3, errors: 0 });
    const reasons = body.skipped.map((row: any) => row.reason).sort();
    expect(reasons).toEqual(['clientCode_duplicate', 'nif_duplicate', 'phone_duplicate']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM clients').get()).toEqual({ n: 2 });
  });

  test('GET /api/clients/:id/profitability returns 404 for an unknown client', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/clients/9999/profitability' });
    expect(response.statusCode).toBe(404);
  });

  test('GET /api/clients/:id/profitability returns an empty snapshot for a client without investments or payments', async () => {
    const id = db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, status)
      VALUES ('CLT-EMPTY', 'Sem historico', '9000000', 'active')
    `).run().lastInsertRowid as number;

    const response = await app.inject({ method: 'GET', url: `/api/clients/${id}/profitability` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.installationCostCve).toBe(0);
    expect(body.investments).toEqual([]);
    expect(body.equipmentUsed).toEqual([]);
    expect(body.paidRevenueCve).toBe(0);
    expect(body.pendingRevenueCve).toBe(0);
    expect(body.monthsActive).toBe(0);
    expect(body.monthsToBreakeven).toBeNull();
    expect(body.profitabilityPct).toBeNull();
    expect(body.isRecovered).toBe(false);
  });

  test('GET /api/clients/:id/profitability aggregates installations, equipment, payments and OPEX share', async () => {
    const clientId = db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, status)
      VALUES ('CLT-VIP', 'Cliente VIP', '9111111', 'active')
    `).run().lastInsertRowid as number;
    const otherClientId = db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, status)
      VALUES ('CLT-OUTRO', 'Outro', '9222222', 'active')
    `).run().lastInsertRowid as number;

    // Investment dedicated to the VIP client with two items.
    const investmentId = db.prepare(`
      INSERT INTO investments
        (name, type, client_id, investment_date, reference_month, status,
         target_clients, installed_clients, total_cost_cve, expected_monthly_revenue_cve)
      VALUES ('Instalacao VIP', 'cliente', ?, '2026-03-01', '2026-03', 'ativo', 1, 1, 12000, 5000)
    `).run(clientId).lastInsertRowid as number;
    db.prepare(`
      INSERT INTO investment_items (investment_id, item_type, item_name, quantity, quantity_used, unit_cost_cve, total_cost_cve)
      VALUES (?, 'cpe', 'CPE 5GHz', 1, 1, 7000, 7000)
    `).run(investmentId);
    db.prepare(`
      INSERT INTO investment_items (investment_id, item_type, item_name, quantity, quantity_used, unit_cost_cve, total_cost_cve)
      VALUES (?, 'mao_obra', 'Instalacao tecnica', 1, 1, 5000, 5000)
    `).run(investmentId);

    // Another active investment for opex denominator (3 installed clients).
    db.prepare(`
      INSERT INTO investments
        (name, type, client_id, investment_date, reference_month, status,
         target_clients, installed_clients, total_cost_cve, expected_monthly_revenue_cve)
      VALUES ('Zona Achada', 'zona', NULL, '2026-02-01', '2026-02', 'ativo', 5, 3, 30000, 15000)
    `).run();

    // Two months of OPEX → avg = 2000 / 2 = 1000; opexPerClient = 1000 / (1+3) = 250.
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Marco', 1000, '2026-03-10', '2026-03')`).run();
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month)
                VALUES ('banda_internet', 'Upstream Abril', 1000, '2026-04-10', '2026-04')`).run();

    // Payments: 2 paid + 1 overdue + 1 from another client (must NOT count).
    db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 5000, 10, 'active')`).run(clientId);
    db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 5000, 10, 'active')`).run(otherClientId);
    const serviceId = db.prepare('SELECT id FROM services WHERE client_id = ?').get(clientId) as { id: number };
    const otherServiceId = db.prepare('SELECT id FROM services WHERE client_id = ?').get(otherClientId) as { id: number };
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                VALUES (?, ?, '2026-03', 5000, '2026-03-10', '2026-03-10', 'paid')`).run(clientId, serviceId.id);
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                VALUES (?, ?, '2026-04', 5000, '2026-04-10', '2026-04-10', 'paid')`).run(clientId, serviceId.id);
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
                VALUES (?, ?, '2026-05', 5000, '2026-05-10', 'overdue')`).run(clientId, serviceId.id);
    db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
                VALUES (?, ?, '2026-03', 5000, '2026-03-10', '2026-03-10', 'paid')`).run(otherClientId, otherServiceId.id);

    const response = await app.inject({ method: 'GET', url: `/api/clients/${clientId}/profitability` });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.client.fullName).toBe('Cliente VIP');
    expect(body.installationCostCve).toBe(12000);
    expect(body.investments).toHaveLength(1);
    expect(body.investments[0].name).toBe('Instalacao VIP');

    expect(body.equipmentUsed).toHaveLength(2);
    expect(body.equipmentUsed.map((e: { itemName: string }) => e.itemName).sort())
      .toEqual(['CPE 5GHz', 'Instalacao tecnica']);

    expect(body.paidRevenueCve).toBe(10000);
    expect(body.pendingRevenueCve).toBe(5000);
    expect(body.monthsActive).toBe(3); // 03, 04, 05
    expect(body.paidMonths).toBe(2);
    expect(body.monthlyAverageRevenueCve).toBe(5000);

    expect(body.imputedMonthlyOpexCve).toBe(250); // opex/cliente
    expect(body.cumulativeOpexCve).toBe(750); // 250 × 3 months
    expect(body.monthlyNetProfitCve).toBe(4750); // 5000 - 250
    expect(body.netProfitCve).toBe(-2750); // 10000 - 12000 - 750
    expect(body.profitabilityPct).toBeCloseTo(-22.917, 2);
    expect(body.isRecovered).toBe(false);
    expect(body.monthsToBreakeven).toBeCloseTo(2.526, 2); // 12000 / 4750
    expect(body.projectedBreakevenDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.companyOpexShare.opexPerClientPerMonth).toBe(250);
  });

  test('reports validation errors per row without rolling back valid inserts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/bulk',
      payload: {
        rows: [
          { fullName: 'OK Person' },
          { fullName: '', phone: '9000002' }, // empty name
          { fullName: 'Bad NIF', nif: '12' }, // not 9 digits
          { fullName: 'Bad Email', email: 'not-an-email' }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ received: 4, inserted: 1, skipped: 0, errors: 3 });
    expect(body.errors).toHaveLength(3);
    expect(body.errors.every((row: any) => row.reason === 'validation')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM clients').get()).toEqual({ n: 1 });
  });
});

describe('GET /api/clients/import-template.xlsx', () => {
  test('returns an XLSX buffer with the expected headers and disposition', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/clients/import-template.xlsx' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers['content-disposition']).toBe('attachment; filename="clientes-template.xlsx"');

    const buffer = response.rawPayload;
    expect(buffer.length).toBeGreaterThan(0);
    // XLSX = ZIP archive → starts with "PK".
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });
});
