/**
 * As rotas dos recebimentos parciais, do lado HTTP.
 *
 * O motor ja e testado em lib/payments.partial.test.ts; aqui interessa o que
 * so a fronteira decide: o que o schema aceita, o que o GET devolve a lista de
 * pagamentos, e os codigos de erro que a interface vai encontrar.
 */
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

const MONTH = '2026-07';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-finance-partial-'));
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
    DELETE FROM client_credits;
    DELETE FROM payment_receipts;
    DELETE FROM payment_lines;
    DELETE FROM payments;
    DELETE FROM services;
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

function seed(amountCve = 50000): { paymentId: number; clientId: number } {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-P1', 'Cliente Parcial', 'active')
  `).run().lastInsertRowid as number;
  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, ?, 10, 'active')
  `).run(clientId, amountCve).lastInsertRowid as number;
  const paymentId = db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, invoice_date)
    VALUES (?, ?, ?, ?, ?, 'pending', 'FT-2026-00042', ?)
  `).run(clientId, serviceId, MONTH, amountCve, `${MONTH}-10`, `${MONTH}-01`).lastInsertRowid as number;
  return { paymentId, clientId };
}

const pay = (paymentId: number, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/payments/${paymentId}/pay`, payload: body });

describe('POST /api/payments/:id/pay com valor', () => {
  test('regista o parcial e devolve recibo, saldo e estado', async () => {
    const { paymentId } = seed();

    const response = await pay(paymentId, { paymentMethod: 'numerario', paymentDate: `${MONTH}-15`, amountCve: 10000 });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.settled).toBe(false);
    expect(body.balanceCve).toBe(40000);
    expect(body.creditAddedCve).toBe(0);
    expect(body.receipt.amountCve).toBe(10000);
    expect(body.receipt.receiptNumber).toMatch(/^RC-\d{4}-\d{5}$/);
  });

  test('sem valor mantem o comportamento antigo: liquida tudo', async () => {
    const { paymentId } = seed();

    const body = (await pay(paymentId, { paymentMethod: 'transferencia' })).json();

    expect(body.settled).toBe(true);
    expect(body.receipt.amountCve).toBe(50000);
  });

  test('recusa valor negativo no schema', async () => {
    const { paymentId } = seed();

    const response = await pay(paymentId, { paymentMethod: 'numerario', amountCve: -5 });

    expect(response.statusCode).toBe(400);
  });

  test('o excesso vai para a conta corrente do cliente', async () => {
    const { paymentId } = seed();

    const body = (await pay(paymentId, { paymentMethod: 'numerario', amountCve: 55000 })).json();

    expect(body.settled).toBe(true);
    expect(body.creditAddedCve).toBe(5000);
  });
});

describe('GET /api/payments', () => {
  test('cada linha traz o recebido e o saldo', async () => {
    const { paymentId } = seed();
    await pay(paymentId, { paymentMethod: 'numerario', amountCve: 12500 });

    const rows = (await app.inject({ method: 'GET', url: '/api/payments' })).json() as Array<Record<string, number>>;

    expect(rows).toHaveLength(1);
    expect(rows[0].receivedCve).toBe(12500);
    expect(rows[0].balanceCve).toBe(37500);
  });
});

describe('GET /api/payments/:id/receipts', () => {
  test('lista os recibos e o credito do cliente', async () => {
    const { paymentId } = seed();
    await pay(paymentId, { paymentMethod: 'numerario', amountCve: 10000 });
    await pay(paymentId, { paymentMethod: 'numerario', amountCve: 45000 });

    const body = (await app.inject({ method: 'GET', url: `/api/payments/${paymentId}/receipts` })).json();

    expect(body.receipts).toHaveLength(2);
    expect(body.clientCreditCve).toBe(5000);
  });

  test('404 num pagamento que nao existe', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/payments/9999/receipts' });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/payments/:id/apply-credit', () => {
  test('abate o credito disponivel na fatura em aberto', async () => {
    const { paymentId, clientId } = seed();
    await pay(paymentId, { paymentMethod: 'numerario', amountCve: 55000 }); // 5.000 de credito

    const next = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      SELECT client_id, service_id, '2026-08', 50000, '2026-08-10', 'pending' FROM payments WHERE id = ?
    `).run(paymentId).lastInsertRowid as number;

    const response = await app.inject({ method: 'POST', url: `/api/payments/${next}/apply-credit` });

    expect(response.statusCode).toBe(200);
    expect(response.json().amountCve).toBe(5000);
    expect(response.json().source).toBe('credit');

    const credit = db.prepare('SELECT COALESCE(SUM(amount_cve), 0) AS total FROM client_credits WHERE client_id = ?')
      .get(clientId) as { total: number };
    expect(credit.total).toBe(0);
  });

  test('400 quando nao ha credito nenhum', async () => {
    const { paymentId } = seed();

    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/apply-credit` });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('credito');
  });
});

describe('POST /api/receipts/:id/void', () => {
  test('anula com motivo e reabre a fatura', async () => {
    const { paymentId } = seed();
    const receiptId = (await pay(paymentId, { paymentMethod: 'numerario' })).json().receipt.id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/receipts/${receiptId}/void`,
      payload: { reason: 'Valor lancado com um zero a mais' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reopened).toBe(true);
    expect(response.json().balanceCve).toBe(50000);
  });

  test('400 sem motivo detalhado', async () => {
    const { paymentId } = seed();
    const receiptId = (await pay(paymentId, { paymentMethod: 'numerario' })).json().receipt.id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/receipts/${receiptId}/void`,
      payload: { reason: 'erro' }
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/receivables', () => {
  test('devolve o saldo por cliente com antiguidade', async () => {
    const { paymentId } = seed();
    await pay(paymentId, { paymentMethod: 'numerario', amountCve: 10000 });

    const body = (await app.inject({ method: 'GET', url: '/api/receivables' })).json();

    expect(body.totals.openCve).toBe(40000);
    expect(body.totals.clients).toBe(1);
    expect(body.clients[0].openCve).toBe(40000);
    expect(body.aging).toHaveProperty('d90plus');
  });
});

describe('PDF do recibo', () => {
  test('imprime o recibo pelo seu id, mesmo com a fatura ainda em aberto', async () => {
    const { paymentId } = seed();
    const receiptId = (await pay(paymentId, { paymentMethod: 'numerario', amountCve: 10000 })).json().receipt.id;

    const response = await app.inject({ method: 'GET', url: `/api/receipts/${receiptId}/receipt.pdf` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('cada recibo imprime o seu, nao o ultimo da fatura', async () => {
    const { paymentId } = seed();
    const first = (await pay(paymentId, { paymentMethod: 'numerario', amountCve: 10000 })).json().receipt;
    const second = (await pay(paymentId, { paymentMethod: 'numerario', amountCve: 15000 })).json().receipt;

    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: `/api/receipts/${first.id}/receipt.pdf` }),
      app.inject({ method: 'GET', url: `/api/receipts/${second.id}/receipt.pdf` })
    ]);

    // O nome do ficheiro carrega o numero: imprimir o recibo de Marco e receber
    // o de Agosto e o defeito que isto tranca.
    expect(a.headers['content-disposition']).toContain(first.receiptNumber);
    expect(b.headers['content-disposition']).toContain(second.receiptNumber);
    expect(a.rawPayload.equals(b.rawPayload)).toBe(false);
  });

  test('a rota por pagamento resolve para o ultimo recibo', async () => {
    const { paymentId } = seed();
    await pay(paymentId, { paymentMethod: 'numerario', amountCve: 10000 });

    const response = await app.inject({ method: 'GET', url: `/api/payments/${paymentId}/receipt.pdf` });

    // Antes exigia a fatura fechada; um parcial ja tem prova para dar.
    expect(response.statusCode).toBe(200);
  });

  test('recusa imprimir um recibo anulado', async () => {
    const { paymentId } = seed();
    const receiptId = (await pay(paymentId, { paymentMethod: 'numerario', amountCve: 10000 })).json().receipt.id;
    await app.inject({
      method: 'POST',
      url: `/api/receipts/${receiptId}/void`,
      payload: { reason: 'Recibo emitido ao cliente errado' }
    });

    const response = await app.inject({ method: 'GET', url: `/api/receipts/${receiptId}/receipt.pdf` });

    expect(response.statusCode).toBe(400);
  });
});
