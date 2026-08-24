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
    DELETE FROM work_orders;
    DELETE FROM service_events;
    DELETE FROM service_install_costs;
    DELETE FROM service_material_lines;
    DELETE FROM service_device_shares;
    DELETE FROM service_device_assignments;
    DELETE FROM payment_lines;
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
    const overdueBody = (fetchMock.mock.calls[0][1]?.body as URLSearchParams).get('body') || '';
    expect(overdueBody).toContain('Atraso Cliente WhatsApp FT-001 2500 04-2026');
    expect(overdueBody).toMatch(/\d{2}-\d{2}-\d{4} ISP CV$/);

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

  test('rejects an empty service (no monthly value and no audiovisual)', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-EMPTY','Vazio','active')`).run();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, monthlyValueCve: 0, dueDay: 10 }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/sem valor/i);
  });

  test('rejects monthly audiovisual without a price', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-AVBAD','AvBad','active')`).run();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, monthlyValueCve: 1000, dueDay: 10, audiovisualMode: 'monthly', audiovisualMonthlyCve: 0 }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/audiovisuais/i);
  });

  test('standalone annual audiovisual service emits the adhesion invoice', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-AVAN','AvAnnual','active')`).run();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 0,
        dueDay: 10,
        activationDate: '2026-06-10',
        audiovisualMode: 'annual',
        audiovisualAnnualCve: 5000
      }
    });
    expect(response.statusCode).toBe(201);

    const payment = db.prepare(`
      SELECT reference_month AS ref, amount_cve AS amount FROM payments WHERE client_id = ?
    `).get(client.lastInsertRowid) as { ref: string; amount: number } | undefined;
    expect(payment).toBeTruthy();
    expect(payment!.ref).toMatch(/^AV-\d{4}-\d{2}$/);
    expect(payment!.amount).toBe(5000);

    const line = db.prepare(`
      SELECT kind, description FROM payment_lines WHERE payment_id = (SELECT id FROM payments WHERE client_id = ?)
    `).get(client.lastInsertRowid) as { kind: string; description: string };
    expect(line.kind).toBe('audiovisual');
    expect(line.description).toBe('Distribuição de Conteúdos Audiovisuais');
  });

  test('creating a service for a plan with an installation fee bills it once', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-INST','Instalacao','active')`).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (name, monthly_price_cve, installation_fee_cve, active)
      VALUES ('Fibra 50M', 3500, 6000, 1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, planId: plan.lastInsertRowid, monthlyValueCve: 3500, dueDay: 10 }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { paymentId: number };
    expect(body.paymentId).toBeTruthy();

    // A mensalidade so e gerada pelo billing mensal (cron/manual) - a criacao do
    // servico so emite a fatura de instalacao.
    const rows = db.prepare(`
      SELECT reference_month AS ref, amount_cve AS amount FROM payments WHERE client_id = ?
    `).all(client.lastInsertRowid) as Array<{ ref: string; amount: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ ref: 'INSTALACAO', amount: 6000 });

    const line = db.prepare(`
      SELECT kind, description, amount_cve AS amount FROM payment_lines WHERE payment_id = ?
    `).get(body.paymentId) as { kind: string; description: string; amount: number };
    expect(line).toEqual({ kind: 'instalacao', description: 'Instalacao', amount: 6000 });
  });

  test('uses the global installation fee from settings when the plan has no override', async () => {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('installationFeeCve','4500')`).run();
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-GINST','GlobalInst','active')`).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (name, monthly_price_cve, installation_fee_cve, active)
      VALUES ('Radio 10M', 2000, 0, 1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, planId: plan.lastInsertRowid, monthlyValueCve: 2000, dueDay: 10 }
    });
    expect(response.statusCode).toBe(201);
    const row = db.prepare(`
      SELECT amount_cve AS amount FROM payments WHERE client_id = ? AND reference_month = 'INSTALACAO'
    `).get(client.lastInsertRowid) as { amount: number } | undefined;
    expect(row?.amount).toBe(4500);
  });

  test('plan installation fee overrides the global setting', async () => {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('installationFeeCve','4500')`).run();
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-OVR','Override','active')`).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (name, monthly_price_cve, installation_fee_cve, active)
      VALUES ('Fibra 100M', 5000, 8000, 1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, planId: plan.lastInsertRowid, monthlyValueCve: 5000, dueDay: 10 }
    });
    expect(response.statusCode).toBe(201);
    const row = db.prepare(`
      SELECT amount_cve AS amount FROM payments WHERE client_id = ? AND reference_month = 'INSTALACAO'
    `).get(client.lastInsertRowid) as { amount: number } | undefined;
    expect(row?.amount).toBe(8000);
  });

  test('does not bill an installation fee when neither plan nor settings define one', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-NOINST','SemInstalacao','active')`).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (name, monthly_price_cve, installation_fee_cve, active)
      VALUES ('Fibra 20M', 2000, 0, 1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, planId: plan.lastInsertRowid, monthlyValueCve: 2000, dueDay: 10 }
    });
    expect(response.statusCode).toBe(201);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE client_id = ?`).get(client.lastInsertRowid))
      .toEqual({ n: 0 });
  });

  test('GET /api/audiovisual-config returns the configured product', async () => {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('audiovisualEnabled','true')`).run();
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('audiovisualMonthlyCve','750')`).run();
    const response = await app.inject({ method: 'GET', url: '/api/audiovisual-config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, monthlyCve: 750 });
  });

  test('creates a service and installs multiple items (device + material) atomically', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-DEV','Cliente Device','active')`).run();
    const router = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','router','MikroTik','hAP ax2', 6000, 400, 200, 0, 1, 5, 1)
    `).run();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','Cabo UTP','metro', 0, 80, 305, 1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 3500,
        dueDay: 10,
        items: [
          { catalogId: router.lastInsertRowid, serialNumber: 'SN-DEV-1' },
          { catalogId: cable.lastInsertRowid, quantity: 30 }
        ]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: number; assignmentIds: number[]; materialLineIds: number[]; eventId: number };
    expect(body.assignmentIds).toHaveLength(1);
    expect(body.materialLineIds).toHaveLength(1);

    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(router.lastInsertRowid)).toEqual({ s: 4 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 275 });
    expect(db.prepare('SELECT quantity AS q, unit_cost_cve AS u FROM service_material_lines WHERE service_id = ?').get(body.id)).toEqual({ q: 30, u: 80 });
    expect(db.prepare("SELECT count(*) AS n FROM service_events WHERE service_id = ? AND event_type = 'instalacao'").get(body.id)).toEqual({ n: 1 });
  });

  test('GET /api/services exposes the IPs of active devices', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-IP','Cliente IP','active')`).run();
    const router = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','router','MikroTik','hAP ip', 6000, 1, 5, 1)
    `).run();

    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 3500,
        dueDay: 10,
        items: [
          { catalogId: router.lastInsertRowid, ipAddress: '10.0.0.1' },
          { catalogId: router.lastInsertRowid, ipAddress: '10.0.0.2' }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const { id: serviceId, assignmentIds } = created.json() as { id: number; assignmentIds: number[] };

    const listed = async () => {
      const response = await app.inject({ method: 'GET', url: '/api/services' });
      const rows = response.json() as Array<{ id: number; deviceIps: string | null }>;
      return rows.find((row) => row.id === serviceId)?.deviceIps;
    };

    expect(await listed()).toBe('10.0.0.1, 10.0.0.2');

    await app.inject({ method: 'POST', url: `/api/service-device-assignments/${assignmentIds[0]}/return`, payload: {} });
    expect(await listed()).toBe('10.0.0.2');

    await app.inject({ method: 'POST', url: `/api/service-device-assignments/${assignmentIds[1]}/return`, payload: {} });
    expect(await listed()).toBeNull();
  });


  test('a shared antenna shows its IP on every service it serves, and guards the delete', async () => {
    const clientA = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C-SA','Cliente SA','active')`).run();
    const clientB = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('C-SB','Cliente SB','active')`).run();
    const antenna = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','antena','TP-Link','CPE710', 3000, 1, 5, 1)
    `).run();

    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: clientA.lastInsertRowid,
        monthlyValueCve: 3000,
        dueDay: 10,
        items: [{ catalogId: antenna.lastInsertRowid, ipAddress: '192.168.1.77' }]
      }
    });
    const owner = created.json() as { id: number; assignmentIds: number[] };

    const sharerService = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: clientB.lastInsertRowid, monthlyValueCve: 3000, dueDay: 10 }
    });
    const sharerId = (sharerService.json() as { id: number }).id;

    const shared = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${owner.assignmentIds[0]}/shares`,
      payload: { serviceId: sharerId }
    });
    expect(shared.statusCode).toBe(201);

    const listed = await app.inject({ method: 'GET', url: '/api/services' });
    const rows = listed.json() as Array<{ id: number; deviceIps: string | null }>;
    expect(rows.find((row) => row.id === owner.id)?.deviceIps).toBe('192.168.1.77');
    expect(rows.find((row) => row.id === sharerId)?.deviceIps).toBe('192.168.1.77');

    const stockBefore = db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(antenna.lastInsertRowid);

    // Apagar o titular deixaria o outro cliente sem antena.
    const blocked = await app.inject({ method: 'DELETE', url: `/api/services/${owner.id}` });
    expect(blocked.statusCode).toBe(409);

    // Apagar o sharer é livre: não mexe em stock nem na atribuição.
    const removed = await app.inject({ method: 'DELETE', url: `/api/services/${sharerId}` });
    expect(removed.statusCode).toBe(204);
    expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(antenna.lastInsertRowid)).toEqual(stockBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_device_assignments WHERE end_date IS NULL').get()).toEqual({ n: 1 });
  });

  test('deletes a service without invoices and restores stock', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-DEL','Cliente Del','active')`).run();
    const router = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','router','MikroTik','hAP', 6000, 1, 5, 1)
    `).run();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','UTP','metro', 0, 80, 305, 1)
    `).run();

    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 3500,
        dueDay: 10,
        items: [
          { catalogId: router.lastInsertRowid, serialNumber: 'SN-DEL-1' },
          { catalogId: cable.lastInsertRowid, quantity: 30 }
        ]
      }
    });
    const serviceId = (created.json() as { id: number }).id;
    // Sanidade: stock abatido pela instalação.
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(router.lastInsertRowid)).toEqual({ s: 4 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 275 });

    const response = await app.inject({ method: 'DELETE', url: `/api/services/${serviceId}` });
    expect(response.statusCode).toBe(204);

    // Serviço e filhos operacionais removidos.
    expect(db.prepare('SELECT count(*) AS n FROM services WHERE id = ?').get(serviceId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM service_device_assignments WHERE service_id = ?').get(serviceId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM service_material_lines WHERE service_id = ?').get(serviceId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM service_events WHERE service_id = ?').get(serviceId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM stock_movements WHERE service_id = ?').get(serviceId)).toEqual({ n: 0 });
    // Stock reposto ao valor original.
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(router.lastInsertRowid)).toEqual({ s: 5 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 305 });
  });

  test('blocks deleting a service that already has an invoice (fiscal rule)', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-FIS','Cliente Fiscal','active')`).run();
    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, monthlyValueCve: 3500, dueDay: 10 }
    });
    const serviceId = (created.json() as { id: number }).id;
    await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2026-06' } });
    expect(db.prepare('SELECT count(*) AS n FROM payments WHERE service_id = ?').get(serviceId)).toEqual({ n: 1 });

    const response = await app.inject({ method: 'DELETE', url: `/api/services/${serviceId}` });
    expect(response.statusCode).toBe(409);
    // Serviço e fatura intactos.
    expect(db.prepare('SELECT count(*) AS n FROM services WHERE id = ?').get(serviceId)).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM payments WHERE service_id = ?').get(serviceId)).toEqual({ n: 1 });
  });

  test('blocks deleting a service whose only invoice is cancelled (numbering persists)', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-CAN','Cliente Cancel','active')`).run();
    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, monthlyValueCve: 3500, dueDay: 10 }
    });
    const serviceId = (created.json() as { id: number }).id;
    await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2026-06' } });
    db.prepare('UPDATE payments SET status = ? WHERE service_id = ?').run('cancelled', serviceId);

    const response = await app.inject({ method: 'DELETE', url: `/api/services/${serviceId}` });
    expect(response.statusCode).toBe(409);
    expect(db.prepare('SELECT count(*) AS n FROM services WHERE id = ?').get(serviceId)).toEqual({ n: 1 });
  });

  test('returns 404 when deleting a non-existent service', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/services/999999' });
    expect(response.statusCode).toBe(404);
  });

  test('preserves a linked work order (service_id set to NULL) when deleting a service', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-WO','Cliente WO','active')`).run();
    const created = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { clientId: client.lastInsertRowid, monthlyValueCve: 3500, dueDay: 10 }
    });
    const serviceId = (created.json() as { id: number }).id;
    const wo = db.prepare(`INSERT INTO work_orders (service_id, title, status) VALUES (?, 'Instalar', 'aguarda')`).run(serviceId);

    const response = await app.inject({ method: 'DELETE', url: `/api/services/${serviceId}` });
    expect(response.statusCode).toBe(204);
    expect(db.prepare('SELECT service_id AS s FROM work_orders WHERE id = ?').get(wo.lastInsertRowid)).toEqual({ s: null });
  });

  test('rolls back the whole service when one item is out of stock', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-NS','Sem Stock','active')`).run();
    const router = db.prepare(`INSERT INTO equipment_catalog (category, type, model, is_serialized, stock_total, active) VALUES ('equipamento','router','R1',1,5,1)`).run();
    const cable = db.prepare(`INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total, active) VALUES ('material','cabo','UTP','metro',0,10,1)`).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 3500,
        dueDay: 10,
        items: [
          { catalogId: router.lastInsertRowid, serialNumber: 'SN-OK' },
          { catalogId: cable.lastInsertRowid, quantity: 50 }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 10' });
    expect(db.prepare('SELECT count(*) AS n FROM services WHERE client_id = ?').get(client.lastInsertRowid)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM service_device_assignments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM stock_movements').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(router.lastInsertRowid)).toEqual({ s: 5 });
  });

  test('records installation labour cost when creating a service', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-LAB','Cliente Mao','active')`).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 3500,
        dueDay: 10,
        installCosts: [{ kind: 'mao_de_obra', description: 'Instalacao no cliente', amountCve: 2500 }]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: number; installCostIds: number[] };
    expect(body.installCostIds).toHaveLength(1);
    expect(db.prepare('SELECT kind, amount_cve AS amount FROM service_install_costs WHERE service_id = ?').get(body.id))
      .toEqual({ kind: 'mao_de_obra', amount: 2500 });
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

  test('skips billing for cancelled clients even if the service stayed active', async () => {
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Cancelado', '50 Mbps', '20 Mbps', 'fibra', 3000)
    `).run();

    const cancelledClient = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-C001', 'Cliente Cancelado', 'cancelled')
    `).run();
    const activeClient = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-A001', 'Cliente Ativo', 'active')
    `).run();

    // Both services remain 'active' — only the client status differs.
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, ?, 3000, '2026-01-15', 15, 'active')
    `).run(cancelledClient.lastInsertRowid, plan.lastInsertRowid);
    db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, ?, 3000, '2026-01-15', 15, 'active')
    `).run(activeClient.lastInsertRowid, plan.lastInsertRowid);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-09' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ referenceMonth: '2026-09', activeServices: 1, created: 1 });

    const billed = db.prepare(`
      SELECT client_id AS clientId FROM payments WHERE reference_month = '2026-09'
    `).all() as Array<{ clientId: number }>;
    expect(billed).toEqual([{ clientId: Number(activeClient.lastInsertRowid) }]);
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

  test('GET /api/payments only exposes regeneration while an anulado slot is free', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-N002', 'Cliente Regeneravel', 'active')
    `).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, 4000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid);
    await app.inject({
      method: 'POST',
      url: '/api/billing/generate-monthly',
      payload: { referenceMonth: '2026-08' }
    });
    const original = db.prepare('SELECT id FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number };
    await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/cancel`,
      payload: { reason: 'Cobranca gerada incorretamente' }
    });

    const before = await app.inject({ method: 'GET', url: '/api/payments' });
    expect(before.json()).toEqual([
      expect.objectContaining({ id: original.id, status: 'cancelled', canRegenerate: 1 })
    ]);

    await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/regenerate`
    });

    const after = await app.inject({ method: 'GET', url: '/api/payments' });
    const rows = after.json() as Array<{ id: number; status: string; canRegenerate: number }>;
    expect(rows.find((row) => row.id === original.id)).toMatchObject({
      status: 'cancelled',
      canRegenerate: 0
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

  test('re-issues a corrected invoice after a registered payment is anulado', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-R001', 'Cliente Reemissao', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve
      )
      VALUES ('Plano Reemissao', '100 Mbps', '50 Mbps', 'fibra', 5000)
    `).run();
    const service = db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day, status
      )
      VALUES (?, ?, 5000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);

    // 1. Generate the month, pay it, then anular the registered payment.
    await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2026-10' } });
    const original = db.prepare('SELECT id, invoice_number AS invoiceNumber FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number; invoiceNumber: string };

    await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2026-10-05' }
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/cancel`,
      payload: { reason: 'Valor faturado incorreto, reemitir corrigido' }
    });
    expect(cancel.statusCode).toBe(200);

    // 2. The month now shows the service as billable again (cancelled row ignored).
    const preview = await app.inject({ method: 'POST', url: '/api/billing/preview-monthly', payload: { referenceMonth: '2026-10' } });
    expect(preview.json()).toMatchObject({ referenceMonth: '2026-10', activeServices: 1, alreadyBilled: 0 });
    expect((preview.json() as { toCreate: unknown[] }).toCreate).toHaveLength(1);

    // 3. Regenerate → a fresh corrected invoice, anulada row preserved.
    const regen = await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2026-10' } });
    expect(regen.json()).toMatchObject({ referenceMonth: '2026-10', created: 1 });

    const rows = db.prepare(`
      SELECT status, invoice_number AS invoiceNumber FROM payments WHERE service_id = ? ORDER BY id
    `).all(service.lastInsertRowid) as Array<{ status: string; invoiceNumber: string }>;
    expect(rows).toHaveLength(2);
    // Original kept as the anulação record; its invoice number is frozen.
    expect(rows[0]).toMatchObject({ status: 'cancelled', invoiceNumber: original.invoiceNumber });
    // New corrected invoice is pending with a different, later sequential number.
    expect(rows[1].status).toBe('pending');
    expect(rows[1].invoiceNumber).toMatch(/^FT-\d{4}-\d{5}$/);
    expect(rows[1].invoiceNumber).not.toBe(original.invoiceNumber);
  });

  test('regenerates an anulado monthly payment with the current service value', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-R002', 'Cliente Regeneracao', 'active')
    `).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, 3000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid);

    await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2026-12' } });
    const original = db.prepare('SELECT id, invoice_number AS invoiceNumber FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number; invoiceNumber: string };
    await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/cancel`,
      payload: { reason: 'Valor mensal incorreto' }
    });
    db.prepare('UPDATE services SET monthly_value_cve = 4500 WHERE id = ?').run(service.lastInsertRowid);

    const response = await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/regenerate`
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      regeneratedFromId: original.id,
      referenceMonth: '2026-12',
      amountCve: 4500,
      status: 'pending'
    });

    const rows = db.prepare(`
      SELECT id, amount_cve AS amountCve, status, invoice_number AS invoiceNumber
      FROM payments WHERE service_id = ? ORDER BY id
    `).all(service.lastInsertRowid) as Array<{ id: number; amountCve: number; status: string; invoiceNumber: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: original.id, amountCve: 3000, status: 'cancelled', invoiceNumber: original.invoiceNumber });
    expect(rows[1]).toMatchObject({ amountCve: 4500, status: 'pending' });
    expect(rows[1].invoiceNumber).toMatch(/^FT-\d{4}-\d{5}$/);
    expect(rows[1].invoiceNumber).not.toBe(original.invoiceNumber);
  });

  test('regenerated monthly payment keeps the audiovisual amount in the total', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-RAV','RegenAv','active')`).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, activation_date, due_day, status, audiovisual_mode, audiovisual_monthly_cve)
      VALUES (?, 2500, '2026-01-15', 15, 'active', 'monthly', 500)
    `).run(client.lastInsertRowid);

    await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2026-12' } });
    const original = db.prepare('SELECT id FROM payments WHERE service_id = ?').get(service.lastInsertRowid) as { id: number };
    // A mensalidade gerada já tem número de fatura, e anular um documento
    // numerado exige motivo detalhado.
    await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/cancel`,
      payload: { reason: 'Valor a corrigir antes de regenerar' }
    });

    const response = await app.inject({ method: 'POST', url: `/api/payments/${original.id}/regenerate` });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ amountCve: 3000 }); // 2500 internet + 500 audiovisual

    const regen = db.prepare(`SELECT id FROM payments WHERE service_id = ? AND status = 'pending'`).get(service.lastInsertRowid) as { id: number };
    const lines = db.prepare(`SELECT kind, amount_cve AS amountCve FROM payment_lines WHERE payment_id = ? ORDER BY sort_order`).all(regen.id);
    expect(lines).toEqual([
      { kind: 'internet', amountCve: 2500 },
      { kind: 'audiovisual', amountCve: 500 }
    ]);
  });

  test.each([
    ['service', 'UPDATE services SET status = ? WHERE id = ?', 'Servico cancelado nao pode regenerar mensalidade'],
    ['client', 'UPDATE clients SET status = ? WHERE id = ?', 'Cliente cancelado nao pode regenerar mensalidade']
  ])('blocks regeneration when the %s is cancelled', async (_entity, sql, error) => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-R003', 'Cliente Bloqueado', 'active')
    `).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, 3000, '2026-01-15', 15, 'active')
    `).run(client.lastInsertRowid);

    await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2027-01' } });
    const original = db.prepare('SELECT id FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number };
    await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/cancel`,
      payload: { reason: 'Cobranca gerada incorretamente' }
    });
    db.prepare(sql).run('cancelled', _entity === 'service' ? service.lastInsertRowid : client.lastInsertRowid);

    const response = await app.inject({
      method: 'POST',
      url: `/api/payments/${original.id}/regenerate`
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error });
    expect(db.prepare('SELECT count(*) AS count FROM payments WHERE service_id = ?').get(service.lastInsertRowid))
      .toEqual({ count: 1 });
  });

  test('the partial unique index blocks a second non-cancelled payment per month', () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-U001', 'Cliente Unico', 'active')
    `).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 3000, 15, 'active')
    `).run(client.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-11', 3000, '2026-11-30', ?)
    `);

    insert.run(client.lastInsertRowid, service.lastInsertRowid, 'pending');
    // A second non-cancelled row for the same (service, month) must be rejected.
    expect(() => insert.run(client.lastInsertRowid, service.lastInsertRowid, 'pending')).toThrow(/UNIQUE/i);
    // But a cancelled row is allowed to coexist.
    expect(() => insert.run(client.lastInsertRowid, service.lastInsertRowid, 'cancelled')).not.toThrow();
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

    // A emissão é carimbada hoje (date('now')); a data de pagamento não pode
    // ser anterior à emissão, por isso paga-se com uma data >= hoje.
    const payDate = new Date().toISOString().slice(0, 10);
    const response = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/pay`,
      payload: { paymentMethod: 'transferencia', paymentDate: payDate }
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
      paymentDate: payDate
    });
    expect(persisted.receiptNumber).toMatch(/^RC-\d{4}-\d{5}$/);
  });

  test('rejects a payment dated before the invoice emission', async () => {
    const client = db.prepare(`
      INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-DT01', 'Cliente Data', 'active')
    `).run();
    const plan = db.prepare(`
      INSERT INTO internet_plans (name, download_speed, upload_speed, connection_type, monthly_price_cve)
      VALUES ('Plano Data', '50', '25', 'fibra', 4000)
    `).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
      VALUES (?, ?, 4000, 15, 'active')
    `).run(client.lastInsertRowid, plan.lastInsertRowid);
    await app.inject({ method: 'POST', url: '/api/billing/generate-monthly', payload: { referenceMonth: '2026-06' } });
    const payment = db.prepare('SELECT id FROM payments WHERE service_id = ?')
      .get(service.lastInsertRowid) as { id: number };

    // Emissão carimbada hoje; pagar a 2020-01-01 é anterior à emissão → 400.
    const response = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/pay`,
      payload: { paymentMethod: 'numerario', paymentDate: '2020-01-01' }
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('não pode ser anterior à data de emissão');
    expect((db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id) as { status: string }).status).toBe('pending');
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

    // paymentDate omitido → assume hoje (não pode ser anterior à emissão).
    await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/pay`,
      payload: { paymentMethod: 'numerario' }
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

describe('service transfer route', () => {
  function seedTransfer() {
    const from = db.prepare(`
      INSERT INTO clients (client_code, full_name, island, zone, status)
      VALUES ('CLT-T1', 'Ana Silva', 'Santiago', 'Praia', 'cancelled')
    `).run();
    const to = db.prepare(`
      INSERT INTO clients (client_code, full_name, island, zone, status)
      VALUES ('CLT-T2', 'Bruno Tavares', 'Santiago', 'Praia', 'cancelled')
    `).run();
    const service = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status)
      VALUES (?, 2500, 10, 'cancelled')
    `).run(from.lastInsertRowid);
    return {
      fromId: Number(from.lastInsertRowid),
      toId: Number(to.lastInsertRowid),
      serviceId: Number(service.lastInsertRowid)
    };
  }

  test('transfere o titular, reativa quem regressa e regista no audit', async () => {
    const fixture = seedTransfer();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${fixture.serviceId}/transfer`,
      payload: { toClientId: fixture.toId, mode: 'manter', reason: 'Cliente regressou' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'manter',
      clientReactivated: true,
      previousStatus: 'cancelled',
      status: 'active',
      toClient: { id: fixture.toId, name: 'Bruno Tavares' }
    });
    expect(db.prepare('SELECT client_id AS clientId, status FROM services WHERE id = ?').get(fixture.serviceId))
      .toEqual({ clientId: fixture.toId, status: 'active' });
    const audit = db.prepare(`
      SELECT action FROM audit_logs
      WHERE entity_type = 'service' AND entity_id = ? AND action = 'transfer'
    `).get(String(fixture.serviceId));
    expect(audit).toBeTruthy();
  });

  test('recusa payload invalido', async () => {
    const fixture = seedTransfer();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${fixture.serviceId}/transfer`,
      payload: { toClientId: 0 }
    });

    expect(response.statusCode).toBe(400);
  });
});

