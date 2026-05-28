import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

// Política: vencimento = data de emissão (hoje) + 30 dias
function expectedDueIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-test-'));
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
  db.exec(`
    DELETE FROM whatsapp_notices;
    DELETE FROM service_events;
    DELETE FROM service_device_assignments;
    DELETE FROM payments;
    DELETE FROM stock_movements;
    DELETE FROM services;
    DELETE FROM internet_plans;
    DELETE FROM equipment_catalog;
    DELETE FROM app_settings;
    DELETE FROM clients;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('stock routes', () => {
  test('rejects invalid stock movement payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/stock',
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Movimento de stock invalido' });
  });

  test('blocks stock exit when quantity exceeds available stock', async () => {
    const catalog = db.prepare(`
      INSERT INTO equipment_catalog (
        type, brand, model, purchase_price_cve, selling_price_cve, stock_total, active
      )
      VALUES ('router', 'Teste', 'Router 1', 1000, 1500, 2, 1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/stock',
      payload: {
        catalogId: catalog.lastInsertRowid,
        type: 'saida',
        quantity: 3
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 2' });
    expect(db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?')
      .get(catalog.lastInsertRowid)).toEqual({ stockTotal: 2 });
    expect(db.prepare('SELECT count(*) AS count FROM stock_movements').get()).toEqual({ count: 0 });
  });
});

describe('settings routes', () => {
  test('returns default settings before customization', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      companyName: 'ISPM',
      defaultDueDay: 1,
      currencyCode: 'CVE',
      invoicePrefix: 'FT',
      receiptPrefix: 'RC',
      whatsappTemplate: 'Ola {nome}, somos da {empresa}. Entramos em contacto sobre o seu servico de internet.',
      whatsappTestTemplate: 'Teste UltraMsg - {empresa}. Ola {nome}, esta mensagem confirma que a integracao WhatsApp esta ativa.',
      whatsappInvoiceReadyTemplate: 'Ola {nome}, a sua fatura {fatura} de {mes} no valor de {valor} CVE ja esta pronta. Vencimento: {vencimento}. {empresa}',
      whatsappReceiptTemplate: 'Ola {nome}, confirmamos o recebimento de {valor} CVE referente a {mes}. O seu recibo {recibo} foi emitido. Obrigado, {empresa}.',
      whatsappOverdueTemplate: 'Ola {nome}, a sua fatura {fatura} de {mes}, no valor de {valor} CVE, esta em atraso desde {vencimento}. Por favor regularize para evitar constrangimentos. {empresa}',
      whatsappSuspensionNoticeDays: 15,
      ultraMsgInstanceId: '',
      ultraMsgToken: ''
    });
  });

  test('saves settings and rejects invalid due day', async () => {
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        companyName: 'ISP Teste',
        defaultDueDay: 40,
        currencyCode: 'CVE',
        invoicePrefix: 'FT',
        receiptPrefix: 'RC'
      }
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Configuracoes invalidas' });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        companyName: 'ISP Teste',
        nif: '123456789',
        phone: '9990000',
        email: 'geral@example.cv',
        address: 'Rua Principal',
        island: 'Santiago',
        defaultDueDay: 15,
        currencyCode: 'CVE',
        invoicePrefix: 'FT',
        receiptPrefix: 'RC',
        ivaRate: 15,
        fiscalRegime: 'normal',
        showIva: false,
        printQrCode: false,
        whatsappTemplate: 'Ola {nome}, a sua mensalidade esta disponivel.',
        whatsappTestTemplate: 'Teste para {nome}',
        whatsappInvoiceReadyTemplate: 'Fatura pronta {fatura}',
        whatsappReceiptTemplate: 'Recibo emitido {recibo}',
        whatsappOverdueTemplate: 'Fatura em atraso {fatura}',
        whatsappSuspensionTemplate: 'Suspensao em {dias_suspensao} dias',
        whatsappSuspensionNoticeDays: 10,
        ultraMsgInstanceId: 'instance1150',
        ultraMsgToken: 'token-teste'
      }
    });

    expect(saved.statusCode).toBe(200);

    const loaded = await app.inject({
      method: 'GET',
      url: '/api/settings'
    });

    expect(loaded.json()).toMatchObject({
      companyName: 'ISP Teste',
      nif: '123456789',
      defaultDueDay: 15,
      whatsappTemplate: 'Ola {nome}, a sua mensalidade esta disponivel.',
      whatsappTestTemplate: 'Teste para {nome}',
      whatsappInvoiceReadyTemplate: 'Fatura pronta {fatura}',
      whatsappReceiptTemplate: 'Recibo emitido {recibo}',
      whatsappOverdueTemplate: 'Fatura em atraso {fatura}',
      whatsappSuspensionTemplate: 'Suspensao em {dias_suspensao} dias',
      whatsappSuspensionNoticeDays: 10,
      ultraMsgInstanceId: 'instance1150',
      ultraMsgToken: 'token-teste'
    });
  });
});

describe('whatsapp routes', () => {
  test('requires UltraMsg credentials before sending', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/send',
      payload: {
        phone: '9910000',
        body: 'Teste'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'UltraMsg nao configurado' });
  });

  test('sends WhatsApp messages through UltraMsg', async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ultraMsgInstanceId', 'instance1150')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ultraMsgToken', 'token-teste')").run();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sent: true }), { status: 200 }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/send',
      payload: {
        phone: '9910000',
        body: 'Ola cliente'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, provider: 'ultramsg' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.ultramsg.com/instance1150/messages/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams)
      })
    );
    const [, options] = fetchMock.mock.calls[0];
    expect((options?.body as URLSearchParams).get('token')).toBe('token-teste');
    expect((options?.body as URLSearchParams).get('to')).toBe('+2389910000');
    expect((options?.body as URLSearchParams).get('body')).toBe('Ola cliente');
    fetchMock.mockRestore();
  });

  test('uses operational templates for overdue and suspension notices', async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ultraMsgInstanceId', 'instance1150')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ultraMsgToken', 'token-teste')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('companyName', 'ISP CV')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('whatsappOverdueTemplate', 'Atraso {nome} {fatura} {valor} {mes} {vencimento} {empresa}')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('whatsappSuspensionTemplate', 'Corte {nome} {dias_atraso}/{dias_suspensao} {fatura}')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('whatsappSuspensionNoticeDays', '10')").run();

    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, status)
      VALUES ('CLT-WA', 'Cliente WhatsApp', '9910000', 'active')
    `).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status)
      VALUES (?, 2500, 1, 'active')
    `).run(client.lastInsertRowid);
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number)
      VALUES (?, ?, '2026-04', 2500, date('now', '-12 days'), 'overdue', 'FT-001')
    `).run(client.lastInsertRowid, service.lastInsertRowid);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sent: true }), { status: 200 }));

    const overdue = await app.inject({
      method: 'POST',
      url: '/api/payments/notify-overdue',
      payload: { dryRun: false, noticeType: 'overdue' }
    });
    expect(overdue.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0][1]?.body as URLSearchParams).get('body')).toContain('Atraso Cliente WhatsApp FT-001 2500 2026-04');

    fetchMock.mockClear();
    const suspension = await app.inject({
      method: 'POST',
      url: '/api/payments/notify-overdue',
      payload: { dryRun: false, noticeType: 'suspension' }
    });
    expect(suspension.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0][1]?.body as URLSearchParams).get('body')).toContain('Corte Cliente WhatsApp 12/10 FT-001');

    fetchMock.mockRestore();
  });
});

describe('finance routes', () => {
  test('rejects invalid service payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Dados de servico invalidos' });
  });

  test('generates monthly payments for active services once per month', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-T001', 'Cliente Teste', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Teste Fibra', '50 Mbps', '20 Mbps', 'fibra', 3500)
    `).run();

    db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 3500, '2026-01-15', 31, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    const first = await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-02' }
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-02' }
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ referenceMonth: '2026-02', activeServices: 1, created: 1 });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ referenceMonth: '2026-02', activeServices: 1, created: 0 });

    const payment = db.prepare(`
      SELECT amount_cve AS amountCve, due_date AS dueDate, status, invoice_number AS invoiceNumber
      FROM payments
    `).get() as { amountCve: number; dueDate: string; status: string; invoiceNumber: string };

    expect(payment).toMatchObject({
      amountCve: 3500,
      dueDate: expectedDueIso(),
      status: 'pending'
    });
    expect(payment.invoiceNumber).toMatch(/^FT-\d{4}-\d{5}$/);
    expect(db.prepare('SELECT count(*) AS count FROM payments').get()).toEqual({ count: 1 });
  });

  test('GET /api/payments exposes clientNif clientPhone and clientCode', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, nif, phone, status)
      VALUES ('CLT-N001', 'Cliente NIF', '111222333', '9912345', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano NIF', '50 Mbps', '20 Mbps', 'fibra', 4000)
    `).run();
    db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 4000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-08' }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/payments'
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{
      clientName: string;
      clientCode: string | null;
      clientNif: string | null;
      clientPhone: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientName: 'Cliente NIF',
      clientCode: 'CLT-N001',
      clientNif: '111222333',
      clientPhone: '9912345'
    });
  });

  test('preview-monthly returns counts without inserting rows', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-P001', 'Cliente Preview', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Preview', '50 Mbps', '20 Mbps', 'fibra', 3500)
    `).run();
    db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 3500, '2026-01-15', 10, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/preview-monthly',
      payload: { referenceMonth: '2026-06' }
    });

    expect(response.statusCode).toBe(200);
    const preview = response.json() as {
      referenceMonth: string;
      activeServices: number;
      alreadyBilled: number;
      totalCve: number;
      toCreate: Array<{ serviceId: number; clientName: string; planName: string; amountCve: number; dueDate: string }>;
    };
    expect(preview).toMatchObject({
      referenceMonth: '2026-06',
      activeServices: 1,
      alreadyBilled: 0,
      totalCve: 3500
    });
    expect(preview.toCreate).toHaveLength(1);
    expect(preview.toCreate[0]).toMatchObject({
      clientName: 'Cliente Preview',
      planName: 'Plano Preview',
      amountCve: 3500,
      dueDate: expectedDueIso()
    });

    expect(db.prepare('SELECT count(*) AS count FROM payments').get()).toEqual({ count: 0 });
  });

  test('preview is idempotent after generate-monthly (no duplicates)', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-P002', 'Cliente Idempotente', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Idempotente', '20 Mbps', '10 Mbps', 'fibra', 2000)
    `).run();
    db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 2000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-07' }
    });

    const second = await app.inject({
      method: 'POST',
      url: '/api/billing/preview-monthly',
      payload: { referenceMonth: '2026-07' }
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      referenceMonth: '2026-07',
      activeServices: 1,
      alreadyBilled: 1,
      totalCve: 0
    });
    expect((second.json() as { toCreate: unknown[] }).toCreate).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS count FROM payments').get()).toEqual({ count: 1 });
  });

  test('registers payment with custom method and date and emits receipt', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-T003', 'Cliente Pago', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Pago', '50 Mbps', '20 Mbps', 'fibra', 4000)
    `).run();
    const service = db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 4000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-03' }
    });

    const payment = db.prepare('SELECT id FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number };

    const response = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/pay`,
      payload: { paymentMethod: 'transferencia', paymentDate: '2026-03-05' }
    });

    expect(response.statusCode).toBe(200);
    const persisted = db.prepare(`
      SELECT
        status,
        payment_method AS paymentMethod,
        payment_date AS paymentDate,
        receipt_number AS receiptNumber
      FROM payments WHERE id = ?
    `).get(payment.id) as { status: string; paymentMethod: string; paymentDate: string; receiptNumber: string };

    expect(persisted).toMatchObject({
      status: 'paid',
      paymentMethod: 'transferencia',
      paymentDate: '2026-03-05'
    });
    expect(persisted.receiptNumber).toMatch(/^RC-\d{4}-\d{5}$/);
  });

  test('invoice and receipt numbers respect configured prefixes', async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('invoicePrefix', 'FAT')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('receiptPrefix', 'REC')").run();

    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-T004', 'Cliente Prefixo', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Prefixo', '50 Mbps', '20 Mbps', 'fibra', 4500)
    `).run();
    const service = db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 4500, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-04' }
    });

    const payment = db.prepare(`
      SELECT id, invoice_number AS invoiceNumber FROM payments WHERE service_id = ?
    `).get(service.lastInsertRowid) as { id: number; invoiceNumber: string };
    expect(payment.invoiceNumber).toMatch(/^FAT-\d{4}-\d{5}$/);

    await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/pay`,
      payload: { paymentMethod: 'numerario' }
    });

    const persisted = db.prepare(`
      SELECT receipt_number AS receiptNumber FROM payments WHERE id = ?
    `).get(payment.id) as { receiptNumber: string };
    expect(persisted.receiptNumber).toMatch(/^REC-\d{4}-\d{5}$/);
  });

  test('settings PUT rejects prefix changes after documents emitted', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-T005', 'Cliente Lock', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Lock', '50 Mbps', '20 Mbps', 'fibra', 5000)
    `).run();
    db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 5000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-05' }
    });

    const basePayload = {
      companyName: 'ISP Teste',
      defaultDueDay: 1,
      currencyCode: 'CVE',
      invoicePrefix: 'FAT',
      receiptPrefix: 'RC',
      ivaRate: 15,
      fiscalRegime: 'normal' as const,
      showIva: false,
      printQrCode: false
    };

    const blockedInvoice = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: basePayload
    });
    expect(blockedInvoice.statusCode).toBe(400);
    expect(blockedInvoice.json()).toEqual({
      error: 'Prefixo de fatura nao pode ser alterado depois de emitida a primeira fatura'
    });

    const sameInvoice = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...basePayload, invoicePrefix: 'FT', receiptPrefix: 'RC' }
    });
    expect(sameInvoice.statusCode).toBe(200);

    const payment = db.prepare('SELECT id FROM payments').get() as { id: number };
    await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/pay`,
      payload: { paymentMethod: 'numerario' }
    });

    const blockedReceipt = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...basePayload, invoicePrefix: 'FT', receiptPrefix: 'REC' }
    });
    expect(blockedReceipt.statusCode).toBe(400);
    expect(blockedReceipt.json()).toEqual({
      error: 'Prefixo de recibo nao pode ser alterado depois de emitido o primeiro recibo'
    });
  });

  test('allows cancelling a pending payment before billing', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-T002', 'Cliente Cancelar', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Cancelar', '20 Mbps', '10 Mbps', 'fibra', 2500)
    `).run();

    const service = db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 2500, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-02' }
    });

    const payment = db.prepare('SELECT id, status FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number; status: string };
    expect(payment.status).toBe('pending');

    const response = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/cancel`,
      payload: { reason: 'Lancado por engano' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'cancelled' });

    const cancelled = db.prepare('SELECT status, notes FROM payments WHERE id = ?')
      .get(payment.id) as { status: string; notes: string | null };
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      notes: 'Lancado por engano'
    });

    const invoice = await app.inject({
      method: 'GET',
      url: `/api/payments/${payment.id}/invoice.pdf`
    });

    expect(invoice.statusCode).toBe(400);
    expect(invoice.json()).toEqual({ error: 'Pagamento anulado nao pode gerar fatura' });
  });

  test('allows cancelling a paid payment when given a 10+ char reason', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-T003', 'Cliente Anular Pago', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Pago', '20 Mbps', '10 Mbps', 'fibra', 4500)
    `).run();
    const service = db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 4500, '2026-01-01', 5, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-03' }
    });

    const payment = db.prepare('SELECT id FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number };

    await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2026-03-05' }
    });

    const paid = db.prepare('SELECT status FROM payments WHERE id = ?')
      .get(payment.id) as { status: string };
    expect(paid.status).toBe('paid');

    const shortReason = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/cancel`,
      payload: { reason: 'curto' }
    });
    expect(shortReason.statusCode).toBe(400);

    const proper = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/cancel`,
      payload: { reason: 'Valor cobrado errado: 5500 em vez de 4500. Cliente notificado.' }
    });
    expect(proper.statusCode).toBe(200);
    expect(proper.json()).toMatchObject({ status: 'cancelled' });

    const cancelled = db.prepare('SELECT status, notes, invoice_number, receipt_number FROM payments WHERE id = ?')
      .get(payment.id) as { status: string; notes: string | null; invoice_number: string | null; receipt_number: string | null };
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.notes).toMatch(/\[ANULACAO POS-PAGAMENTO\]/);
    expect(cancelled.invoice_number).not.toBeNull();
    expect(cancelled.receipt_number).not.toBeNull();
  });

  test('settings PUT rejects a non-existent backupDir', async () => {
    const base = {
      companyName: 'X', defaultDueDay: 1, currencyCode: 'CVE',
      invoicePrefix: 'FT', receiptPrefix: 'RC',
      ivaRate: 15, fiscalRegime: 'normal' as const,
      showIva: false, printQrCode: false,
    };
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...base, backupDir: 'Z:\\nope\\does\\not\\exist' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('settings PUT accepts an empty backupDir (use default)', async () => {
    const base = {
      companyName: 'X', defaultDueDay: 1, currencyCode: 'CVE',
      invoicePrefix: 'FT', receiptPrefix: 'RC',
      ivaRate: 15, fiscalRegime: 'normal' as const,
      showIva: false, printQrCode: false,
    };
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...base, backupDir: '' },
    });
    expect(res.statusCode).toBe(200);
  });
});
