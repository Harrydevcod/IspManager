import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

let app: FastifyInstance;
let db: Database.Database;
let dir: string;
let close: () => void;
let admin: string;
let operator: string;
let technician: string;
let accountId: number;
const headers = (token = admin) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ispm-tv-api-'));
  process.env.ISPM_DATA_DIR = dir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  delete process.env.ISPM_AUTH;
  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  close = database.closeDatabaseForTests;
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: {
    username: 'admin', password: 'supersecret', fullName: 'Admin'
  } });
  expect(setup.statusCode).toBe(201);
  admin = setup.json().token;
  for (const role of ['operator', 'technician']) {
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: headers(), payload: {
      username: role, password: 'user-secret-123', fullName: role, role
    } });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: role, password: 'user-secret-123' } });
    if (role === 'operator') operator = login.json().token;
    else technician = login.json().token;
  }
});
beforeEach(async () => {
  db.exec(`DELETE FROM audit_logs; DELETE FROM stock_movements; DELETE FROM sale_ticket_serials;
    DELETE FROM sale_ticket_lines; DELETE FROM treasury_movements; DELETE FROM payment_receipts;
    DELETE FROM payment_lines; DELETE FROM payments; DELETE FROM equipment_catalog; DELETE FROM treasury_accounts;
    DELETE FROM login_throttle;`);
  const { createAccount } = await import('../lib/treasury');
  const result = createAccount(db, { kind: 'caixa', name: 'Caixa de venda', openingDate: '2020-01-01' });
  if (!result.ok) throw new Error(result.error);
  accountId = result.value.id;
});
afterAll(async () => {
  await app?.close(); close?.();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR; delete process.env.ISPM_AUTO_BILLING; delete process.env.ISPM_RECURRING_EXPENSES;
});

const body = () => ({ requestKey: randomUUID(), paymentMethod: 'numerario', accountId,
  lines: [{ description: 'Venda avulsa', quantity: 2, unitPriceCve: 125.25 }] });
async function issue(payload = body(), token = admin) {
  return app.inject({ method: 'POST', url: '/api/payments/sale-tickets', headers: headers(token), payload });
}
async function ticket() {
  const response = await issue(); expect(response.statusCode).toBe(201); return response.json();
}
const cancel = (id: number, token = admin, password = 'supersecret', productsReturned = true) => app.inject({
  method: 'POST', url: `/api/payments/${id}/sale-ticket/cancel`, headers: headers(token),
  payload: { reason: 'Venda emitida por engano', confirmPassword: password, productsReturned }
});

test('emite pela API, carrega detalhe e lista o tipo TV e valor recebido', async () => {
  const sale = await ticket();
  expect(sale).toMatchObject({ documentType: 'sale_ticket', status: 'paid', amountCve: 250.5 });
  expect(sale.documentNumber).toMatch(/^TV-\d{4}-\d{5}$/);
  const detail = await app.inject({ url: `/api/payments/${sale.paymentId}/sale-ticket`, headers: headers() });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toMatchObject({ clientName: 'Cliente Indiferenciado', status: 'paid', lines: [{ quantity: 2, totalCve: 250.5 }] });
  const list = await app.inject({ url: '/api/payments', headers: headers() });
  expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({
    id: sale.paymentId, documentType: 'sale_ticket', receivedCve: 250.5, balanceCve: 0
  })]));
  const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action='create' AND entity_type='payment'").get() as { metadata_json: string };
  expect(JSON.parse(audit.metadata_json)).toMatchObject({ documentType: 'sale_ticket', accountId, lines: [{ quantity: 2 }] });
});
test('repetição HTTP devolve o mesmo TV sem repetir dinheiro, documento ou auditoria', async () => {
  const payload = body(); const first = await issue(payload); const second = await issue(payload);
  expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201);
  expect(second.json()).toEqual(first.json());
  expect(db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity_type='payment' AND action='create'").get()).toEqual({ n: 1 });
});
test('administrador e operador podem emitir; técnico e pedido sem autenticação não podem', async () => {
  expect((await issue(body(), operator)).statusCode).toBe(201);
  expect((await issue(body(), technician)).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/payments/sale-tickets', payload: body() })).statusCode).toBe(401);
});
test('anulação exige administrador, password correta e devolução antes de alterar dinheiro', async () => {
  const sale = await ticket();
  expect((await cancel(sale.paymentId, operator, 'user-secret-123')).statusCode).toBe(403);
  expect((await cancel(sale.paymentId, admin, 'password-errada')).statusCode).toBe(403);
  expect((await cancel(sale.paymentId, admin, 'supersecret', false)).statusCode).toBe(400);
  expect(db.prepare('SELECT status FROM payments WHERE id=?').get(sale.paymentId)).toEqual({ status: 'paid' });
  expect((await cancel(sale.paymentId)).statusCode).toBe(200);
  expect((await cancel(sale.paymentId)).statusCode).toBe(200);
  expect(db.prepare('SELECT count(*) AS n FROM treasury_movements').get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='cancel'").get()).toEqual({ n: 1 });
});
test.each(['a4', 'a5', '80mm'])('PDF %s está disponível, incluindo depois da anulação', async (format) => {
  const sale = await ticket();
  for (const annul of [false, true]) {
    if (annul) expect((await cancel(sale.paymentId)).statusCode).toBe(200);
    const pdf = await app.inject({ url: `/api/payments/${sale.paymentId}/sale-ticket.pdf?format=${format}&inline=1`, headers: headers() });
    expect(pdf.statusCode).toBe(200); expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.headers['content-disposition'])).toContain('inline');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    if (format !== '80mm') expect(pdf.rawPayload.toString('latin1')).toContain(format === 'a5' ? '/MediaBox [0 0 419.53 595.28]' : '/MediaBox [0 0 595.28 841.89]');
  }
});

test('PDF sem formato mantém A4 por compatibilidade', async () => {
  const sale = await ticket();
  const pdf = await app.inject({ url: `/api/payments/${sale.paymentId}/sale-ticket.pdf`, headers: headers() });
  expect(pdf.statusCode).toBe(200);
  expect(pdf.rawPayload.toString('latin1')).toContain('/MediaBox [0 0 595.28 841.89]');
});
test('rotas genéricas recusam reabrir, anular, regenerar, Stripe ou emitir FT/RC do TV', async () => {
  const sale = await ticket();
  for (const action of ['pay', 'cancel', 'revert', 'regenerate', 'stripe-link']) {
    const response = await app.inject({ method: 'POST', url: `/api/payments/${sale.paymentId}/${action}`, headers: headers(),
      payload: { paymentMethod: 'numerario', reason: 'Tentativa fora do fluxo TV' } });
    expect(response.statusCode).toBe(409);
  }
  for (const kind of ['invoice', 'receipt']) {
    const response = await app.inject({ url: `/api/payments/${sale.paymentId}/${kind}.pdf`, headers: headers() });
    expect(response.statusCode).toBe(409);
  }
  const receipt = db.prepare('SELECT id FROM payment_receipts WHERE payment_id=?').get(sale.paymentId) as { id: number };
  expect((await app.inject({ url: `/api/receipts/${receipt.id}/receipt.pdf`, headers: headers() })).statusCode).toBe(409);
});

test('falha de auditoria reverte a emissão inteira e permite repetir a mesma chave', async () => {
  const payload = body(); const sequence = db.prepare('SELECT * FROM document_sequences').all();
  db.exec("CREATE TEMP TRIGGER fail_tv_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type='payment' BEGIN SELECT RAISE(ABORT,'forced audit failure'); END");
  try {
    expect((await issue(payload)).statusCode).toBe(500);
    expect(db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM treasury_movements').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT * FROM document_sequences').all()).toEqual(sequence);
  } finally { db.exec('DROP TRIGGER fail_tv_audit'); }
  expect((await issue(payload)).statusCode).toBe(201);
});

test.each(['invoicePrefix', 'receiptPrefix'])('configurações reservam TV para talões: %s', async (key) => {
  const current = (await app.inject({ url: '/api/settings', headers: headers() })).json();
  const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: headers(), payload: { ...current, [key]: 'TV' } });
  expect(response.statusCode).toBe(400);
});

test('configuração antiga TV pode ser corrigida sem alterar documentos emitidos', async () => {
  const clientId = Number(db.prepare("INSERT INTO clients(client_code,full_name) VALUES ('LEGACY-TV','Cliente antigo')").run().lastInsertRowid);
  db.prepare("INSERT INTO payments(client_id,reference_month,amount_cve,due_date,invoice_number,receipt_number,status) VALUES (?,'AVULSA-LEGACY',100,'2025-12-31','TV-2025-00001','TV-2025-00002','paid')").run(clientId);
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('invoicePrefix','TV'),('receiptPrefix','TV')").run();
  const current = (await app.inject({ url: '/api/settings', headers: headers() })).json();
  expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: headers(), payload: { ...current, invoicePrefix: 'FT', receiptPrefix: 'RC' } })).statusCode).toBe(200);
  expect(db.prepare("SELECT invoice_number,receipt_number FROM payments WHERE client_id=?").get(clientId))
    .toEqual({ invoice_number: 'TV-2025-00001', receipt_number: 'TV-2025-00002' });
  expect((await issue()).statusCode).toBe(201);
});

test('emitir só TV não congela o prefixo de faturas que ainda não foram emitidas', async () => {
  await ticket();
  const current = (await app.inject({ url: '/api/settings', headers: headers() })).json();
  expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: headers(), payload: { ...current, invoicePrefix: 'FAT' } })).statusCode).toBe(200);
});
test('rejeita IDs, formato e corpo inválidos sem efeitos', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/payments/sale-tickets', headers: headers(), payload: {} })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/payments/abc/sale-ticket', headers: headers() })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/payments/999999/sale-ticket', headers: headers() })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/payments/1/sale-ticket.pdf?format=a3', headers: headers() })).statusCode).toBe(400);
});

test('relatórios contam TV e FT uma vez e filtram o tipo sem misturar caixa', async () => {
  await ticket();
  const clientId = Number(db.prepare("INSERT INTO clients(client_code,full_name) VALUES ('FT-CLIENT','Cliente com NIF')").run().lastInsertRowid);
  const issued = await app.inject({ method: 'POST', url: '/api/payments/manual', headers: headers(), payload: {
    clientId, lines: [{ description: 'Fatura livre', amountCve: 300 }]
  } });
  expect(issued.statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: `/api/payments/${issued.json().paymentId}/pay`, headers: headers(),
    payload: { paymentMethod: 'numerario', accountId, amountCve: 100 } })).statusCode).toBe(200);
  const summary = (await app.inject({ url: '/api/reports/summary', headers: headers() })).json();
  expect(summary.revenueByMonth.reduce((sum: number, row: { paidCve: number }) => sum + row.paidCve, 0)).toBe(350.5);
  expect(summary.revenueByMonth.reduce((sum: number, row: { cashCve: number }) => sum + row.cashCve, 0)).toBe(350.5);
  const filtered = (await app.inject({ url: '/api/reports/summary?documentType=sale_ticket', headers: headers() })).json();
  expect(filtered.revenueByMonth).toEqual([expect.objectContaining({ documentType: 'sale_ticket', paidCve: 250.5, cashCve: 250.5, pendingCve: 0, payments: 1 })]);
  const invoices = (await app.inject({ url: '/api/reports/summary?documentType=invoice', headers: headers() })).json();
  expect(invoices.revenueByMonth).toEqual([expect.objectContaining({ documentType: 'invoice', paidCve: 100, cashCve: 100, pendingCve: 200 })]);
});
