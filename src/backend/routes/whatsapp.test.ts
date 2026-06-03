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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-whatsapp-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM whatsapp_outbox').run();
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
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
  delete process.env.ISPM_AUTH;
});

function insertOverdueClient(params: {
  code: string;
  name: string;
  phone: string | null;
  daysOverdue: number;
  optOut?: boolean;
}) {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, phone, status, whatsapp_opt_out)
    VALUES (?, ?, ?, 'active', ?)
  `).run(params.code, params.name, params.phone, params.optOut ? 1 : 0).lastInsertRowid as number;

  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, 2500, 10, 'active')
  `).run(clientId).lastInsertRowid as number;

  db.prepare(`
    INSERT INTO payments (
      client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number
    )
    VALUES (?, ?, strftime('%Y-%m', 'now'), 2500, date('now', ?), 'overdue', ?)
  `).run(clientId, serviceId, `-${params.daysOverdue} days`, `FT-${params.code}`);

  return clientId;
}

describe('WhatsApp outbox routes', () => {
  test('POST /api/whatsapp/send enqueues and processes the row', async () => {
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();

    const response = await app.inject({
      method: 'POST', url: '/api/whatsapp/send',
      payload: { phone: '9912233', body: 'ola' }
    });
    expect(response.statusCode).toBe(200);
    const n = db.prepare('SELECT COUNT(*) AS n FROM whatsapp_outbox').get() as { n: number };
    expect(n.n).toBe(1);
  });

  test('POST /api/payments/:id/whatsapp enqueues a document row', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C0001','Ana','9912233','active')`).run().lastInsertRowid as number;
    const planId = db.prepare(`INSERT INTO internet_plans (name, monthly_price_cve) VALUES ('P50', 4500)`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status) VALUES (?, ?, 4500, 10, 'active')`).run(clientId, planId).lastInsertRowid as number;
    const paymentId = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-05', 4500, '2026-05-10', 'paid')
    `).run(clientId, serviceId).lastInsertRowid as number;
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();

    const response = await app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/whatsapp`,
      payload: { kind: 'receipt' }
    });
    expect(response.statusCode).toBe(200);
    const row = db.prepare('SELECT kind, doc_payment_id, doc_kind FROM whatsapp_outbox').get() as { kind: string; doc_payment_id: number; doc_kind: string };
    expect(row.kind).toBe('document');
    expect(row.doc_payment_id).toBe(paymentId);
    expect(row.doc_kind).toBe('receipt');
  });

  test('POST /api/payments/:id/whatsapp rejects a client without phone', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C0002','Sem Fone', NULL,'active')`).run().lastInsertRowid as number;
    const planId = db.prepare(`INSERT INTO internet_plans (name, monthly_price_cve) VALUES ('P50b', 4500)`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status) VALUES (?, ?, 4500, 10, 'active')`).run(clientId, planId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-05', 4500, '2026-05-10', 'paid')`).run(clientId, serviceId).lastInsertRowid as number;
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/whatsapp`, payload: { kind: 'receipt' } });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/payments/notify-overdue', () => {
  test('dry-run suspension notices only include invoices past the configured suspension threshold', async () => {
    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES ('whatsappSuspensionNoticeDays', '15')
    `).run();

    insertOverdueClient({ code: 'CLT-OLD', name: 'Cliente Atrasado', phone: '9910000', daysOverdue: 20 });
    insertOverdueClient({ code: 'CLT-NEW', name: 'Cliente Recente', phone: '9920000', daysOverdue: 5 });
    insertOverdueClient({ code: 'CLT-OPT', name: 'Cliente Opt Out', phone: '9930000', daysOverdue: 22, optOut: true });
    insertOverdueClient({ code: 'CLT-NOPHONE', name: 'Cliente Sem Telefone', phone: null, daysOverdue: 23 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/notify-overdue',
      payload: { dryRun: true, noticeType: 'suspension' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ dryRun: true, total: 3 });
    expect(body.eligible).toHaveLength(1);
    expect(body.eligible[0]).toMatchObject({
      clientName: 'Cliente Atrasado',
      clientCode: 'CLT-OLD',
      daysOverdue: expect.any(Number),
      amountCve: 2500
    });
    expect(body.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientName: 'Cliente Opt Out', status: 'skipped', reason: 'opt-out' }),
      expect.objectContaining({ clientName: 'Cliente Sem Telefone', status: 'skipped', reason: 'sem telefone valido' })
    ]));
  });
});
