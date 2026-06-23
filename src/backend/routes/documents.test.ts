import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { formatBankAccountsForDocument, formatDate } from './documents';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-documents-test-'));
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
  db.prepare('DELETE FROM payment_lines').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

function seedPayment(status: 'pending' | 'paid' | 'overdue' | 'cancelled' = 'paid'): number {
  const clientId = db
    .prepare(`INSERT INTO clients (client_code, full_name, phone, nif, status) VALUES ('CLT-0001', 'Ana Lima', '9111111', '123456789', 'active')`)
    .run().lastInsertRowid as number;
  const planId = db
    .prepare(`INSERT INTO internet_plans (name, download_speed, upload_speed, connection_type, monthly_price_cve) VALUES ('Plano 50', '50', '25', 'fibra', 4500)`)
    .run().lastInsertRowid as number;
  const serviceId = db
    .prepare(`INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status) VALUES (?, ?, 4500, 10, 'active')`)
    .run(clientId, planId).lastInsertRowid as number;
  const paymentDate = status === 'paid' ? '2026-05-10' : null;
  const paymentMethod = status === 'paid' ? 'numerario' : null;
  return db
    .prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, payment_method, status)
      VALUES (?, ?, '2026-05', 4500, '2026-05-10', ?, ?, ?)
    `)
    .run(clientId, serviceId, paymentDate, paymentMethod, status).lastInsertRowid as number;
}

describe('GET /api/payments/:id/invoice.pdf', () => {
  test('formats document dates with pt-PT day/month/year order', () => {
    expect(formatDate('2026-05-10')).toBe('10/05/2026');
    expect(formatDate('2026-05-10 14:30:00')).toBe('10/05/2026');
    expect(formatDate(null)).toBe('-');
  });

  test('formats bank accounts for invoice payment instructions', () => {
    expect(formatBankAccountsForDocument([
      {
        bankName: 'BCA',
        accountName: 'ISPM Lda',
        accountNumber: 'CV64 0001 0000 0000 0000 0000 1',
        reference: 'Mensalidades'
      },
      {
        bankName: 'Caixa Economica',
        accountName: 'ISPM Lda',
        accountNumber: 'CV64 0002 0000 0000 0000 0000 2',
        reference: 'Instalacoes'
      }
    ])).toBe([
      'Bancos:',
      'BCA: CV64 0001 0000 0000 0000 0000 1',
      'Caixa Economica: CV64 0002 0000 0000 0000 0000 2'
    ].join('\n'));
  });

  test('rejects malformed id with 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/payments/abc/invoice.pdf' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Pagamento invalido' });
  });

  test('returns 404 when payment does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/payments/9999/invoice.pdf' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Pagamento nao encontrado' });
  });

  test('refuses to issue an invoice for a cancelled payment', async () => {
    const id = seedPayment('cancelled');
    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/anulado/i);
  });

  test('returns a PDF buffer and auto-numbers the invoice', async () => {
    const id = seedPayment('pending');
    const before = db.prepare('SELECT invoice_number FROM payments WHERE id = ?').get(id) as { invoice_number: string | null };
    expect(before.invoice_number).toBeNull();

    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(String(response.headers['content-disposition'])).toContain('attachment');
    expect(response.rawPayload.length).toBeGreaterThan(500);
    expect(response.rawPayload.slice(0, 4).toString('ascii')).toBe('%PDF');

    const after = db.prepare('SELECT invoice_number, invoice_date FROM payments WHERE id = ?').get(id) as { invoice_number: string; invoice_date: string };
    expect(after.invoice_number).toBeTruthy();
    expect(after.invoice_number).not.toBe('PENDING');
    expect(after.invoice_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('returns a PDF buffer when invoice payment bank accounts are configured', async () => {
    const id = seedPayment('pending');
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('bankAccounts', ?)`).run(JSON.stringify([
      {
        bankName: 'BCA',
        accountName: 'ISPM Lda',
        accountNumber: 'CV64 0001 0000 0000 0000 0000 1',
        reference: 'Mensalidades'
      },
      {
        bankName: 'Caixa Economica',
        accountName: 'ISPM Lda',
        accountNumber: 'CV64 0002 0000 0000 0000 0000 2',
        reference: 'Instalacoes'
      }
    ]));

    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.rawPayload.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('keeps existing invoice number on second hit (idempotent numbering)', async () => {
    const id = seedPayment('pending');
    const first = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf` });
    expect(first.statusCode).toBe(200);
    const initial = db.prepare('SELECT invoice_number FROM payments WHERE id = ?').get(id) as { invoice_number: string };

    const second = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf` });
    expect(second.statusCode).toBe(200);
    const after = db.prepare('SELECT invoice_number FROM payments WHERE id = ?').get(id) as { invoice_number: string };
    expect(after.invoice_number).toBe(initial.invoice_number);
  });

  test('switches Content-Disposition to inline when ?inline=1', async () => {
    const id = seedPayment('pending');
    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf?inline=1` });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-disposition'])).toContain('inline');
  });

  test('renders a multi-line invoice (internet + audiovisual) without error', async () => {
    const id = seedPayment('pending');
    // Composição combinada: o pagamento traz duas linhas; a fatura percorre-as.
    db.prepare(`INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order) VALUES (?, 'internet', 'Servico de Internet', 4500, 0)`).run(id);
    db.prepare(`INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order) VALUES (?, 'audiovisual', 'Distribuição de Conteúdos Audiovisuais', 500, 1)`).run(id);
    db.prepare('UPDATE payments SET amount_cve = 5000 WHERE id = ?').run(id);

    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.rawPayload.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('legacy payment without lines still renders the internet line', async () => {
    const id = seedPayment('pending'); // sem payment_lines → fallback histórico
    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/invoice.pdf` });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});

describe('GET /api/payments/:id/receipt.pdf', () => {
  test('returns 404 when payment does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/payments/9999/receipt.pdf' });
    expect(response.statusCode).toBe(404);
  });

  test('refuses to issue a receipt for a payment that is not paid', async () => {
    const id = seedPayment('pending');
    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/receipt.pdf` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/pagamento/i);
  });

  test('refuses to issue a receipt for a cancelled payment', async () => {
    const id = seedPayment('cancelled');
    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/receipt.pdf` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/anulado/i);
  });

  test('returns a PDF buffer and auto-numbers the receipt for a paid payment', async () => {
    const id = seedPayment('paid');
    const before = db.prepare('SELECT receipt_number FROM payments WHERE id = ?').get(id) as { receipt_number: string | null };
    expect(before.receipt_number).toBeNull();

    const response = await app.inject({ method: 'GET', url: `/api/payments/${id}/receipt.pdf` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.rawPayload.slice(0, 4).toString('ascii')).toBe('%PDF');

    const after = db.prepare('SELECT receipt_number, receipt_date FROM payments WHERE id = ?').get(id) as { receipt_number: string; receipt_date: string };
    expect(after.receipt_number).toBeTruthy();
    expect(after.receipt_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
