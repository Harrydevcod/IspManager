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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-sms-routes-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

function seedPaidPayment() {
  const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C1','Ana','9912233','active')`).run().lastInsertRowid as number;
  const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?,4500,10,'active')`).run(clientId).lastInsertRowid as number;
  const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status, receipt_number) VALUES (?,?,'2026-06',4500,'2026-06-10','2026-06-04','paid','RC-1')`).run(clientId, serviceId).lastInsertRowid as number;
  return { clientId, serviceId, paymentId };
}

describe('SMS routes', () => {
  test('GET /api/sms/status returns pairing and queue counts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sms/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ paired: false, counts: { pendingDispatch: 0, pendingApproval: 0 } });
  });

  test('POST /api/sms/pairing creates a pairing payload and marks paired', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sms/pairing', payload: { baseUrl: 'http://192.168.1.50:8765', deviceName: 'Android A' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.qrPayload).toContain('ispm-sms://pair');
    expect(body.secret).toBeTruthy();

    const status = await app.inject({ method: 'GET', url: '/api/sms/status' });
    expect(status.json()).toMatchObject({ paired: true });
  });

  test('DELETE /api/sms/pairing revokes the companion', async () => {
    await app.inject({ method: 'POST', url: '/api/sms/pairing', payload: { baseUrl: 'http://192.168.1.50:8765', deviceName: 'Android A' } });
    const response = await app.inject({ method: 'DELETE', url: '/api/sms/pairing' });
    expect(response.statusCode).toBe(200);
    const status = await app.inject({ method: 'GET', url: '/api/sms/status' });
    expect(status.json()).toMatchObject({ paired: false });
  });

  test('POST /api/payments/:id/sms enqueues receipt SMS', async () => {
    const { paymentId } = seedPaidPayment();
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'receipt_confirmed' } });
    expect(response.statusCode).toBe(200);
    const row = db.prepare('SELECT event_type, status, to_phone FROM sms_outbox').get() as { event_type: string; status: string; to_phone: string };
    expect(row).toMatchObject({ event_type: 'receipt_confirmed', status: 'pending_dispatch', to_phone: '+2389912233' });
  });

  test('POST /api/payments/:id/sms rejects a receipt for an unpaid payment', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C2','Beto','9912244','active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?,4500,10,'active')`).run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?,?,'2026-06',4500,'2026-06-10','pending')`).run(clientId, serviceId).lastInsertRowid as number;
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'receipt_confirmed' } });
    expect(response.statusCode).toBe(400);
  });

  test('POST /api/payments/:id/sms rejects a client without phone', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C3','Sem Fone', NULL,'active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?,4500,10,'active')`).run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?,?,'2026-06',4500,'2026-06-10','overdue')`).run(clientId, serviceId).lastInsertRowid as number;
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'payment_overdue' } });
    expect(response.statusCode).toBe(400);
  });

  test('POST /api/payments/:id/sms rejects an unknown event type', async () => {
    const { paymentId } = seedPaidPayment();
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'nonsense' } });
    expect(response.statusCode).toBe(400);
  });
});
