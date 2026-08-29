/**
 * Pagamentos parciais: o dinheiro entra aos bocados e a fatura so fecha quando
 * a soma a cobre.
 *
 * A assercao que interessa em quase todos estes testes e a mesma: o saldo. Um
 * sistema de cobranca que perde a conta ao que falta receber e pior do que nao
 * ter sistema nenhum — por isso cada caminho (parcial, excesso, credito,
 * anulacao, estorno) e verificado pelo que deixa por receber.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let payments: typeof import('./payments');
let receivables: typeof import('./receivables');

const MONTH = '2026-07';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-partial-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // corre as migrações
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  payments = await import('./payments');
  receivables = await import('./receivables');
});

beforeEach(() => {
  // Filhos primeiro: creditos → recibos → linhas → payments → services/clients.
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payment_lines').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

type Seeded = { paymentId: number; clientId: number };

function seed(code: string, { amountCve = 50000, dueDate = `${MONTH}-10`, invoiceNumber = 'FT-2026-00042' } = {}): Seeded {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(code, `Cliente ${code}`).lastInsertRowid as number;

  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, ?, 10, 'active')
  `).run(clientId, amountCve).lastInsertRowid as number;

  const paymentId = db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, invoice_date)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(clientId, serviceId, MONTH, amountCve, dueDate, invoiceNumber, `${MONTH}-01`).lastInsertRowid as number;

  return { paymentId, clientId };
}

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM payments WHERE id = ?').get(id) as { status: string }).status;

const receiptNumberOf = (id: number) =>
  (db.prepare('SELECT receipt_number AS n FROM payments WHERE id = ?').get(id) as { n: string | null }).n;

const pay = (paymentId: number, amountCve?: number, paymentDate = `${MONTH}-15`) =>
  payments.payPayment(db, paymentId, { paymentMethod: 'numerario', paymentDate, amountCve });

describe('recebimento parcial', () => {
  test('10.000 de 50.000 deixa saldo e a fatura em aberto', () => {
    const { paymentId } = seed('A');

    const result = pay(paymentId, 10000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.balanceCve).toBe(40000);
    expect(result.value.settled).toBe(false);
    expect(result.value.receipt.amountCve).toBe(10000);
    expect(result.value.receipt.receiptNumber).toMatch(/^RC-\d{4}-\d{5}$/);
    expect(statusOf(paymentId)).toBe('pending');
    expect(payments.receivedTotal(db, paymentId)).toBe(10000);
  });

  test('cada parcial leva o seu recibo e o ultimo fecha a fatura', () => {
    const { paymentId } = seed('B');

    pay(paymentId, 10000, `${MONTH}-10`);
    pay(paymentId, 15000, `${MONTH}-22`);
    const last = pay(paymentId, 25000, `${MONTH}-29`);

    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.value.settled).toBe(true);
    expect(last.value.balanceCve).toBe(0);
    expect(statusOf(paymentId)).toBe('paid');

    const receipts = payments.listPaymentReceipts(db, paymentId);
    expect(receipts.map((r) => r.amountCve)).toEqual([10000, 15000, 25000]);
    expect(new Set(receipts.map((r) => r.receiptNumber)).size).toBe(3);
    // A fatura fica com o numero do recibo que a saldou: e o que o PDF por
    // fatura vai buscar.
    expect(receiptNumberOf(paymentId)).toBe(last.value.receipt.receiptNumber);
  });

  test('sem valor continua a receber tudo de uma vez, como sempre foi', () => {
    const { paymentId } = seed('C');

    const result = pay(paymentId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.amountCve).toBe(50000);
    expect(statusOf(paymentId)).toBe('paid');
  });

  test('recusa receber o que ja esta totalmente recebido', () => {
    const { paymentId } = seed('D');
    pay(paymentId);

    const again = pay(paymentId, 1000);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.status).toBe(400);
    expect(again.error).toContain('totalmente recebida');
  });

  test('recusa valor nao positivo', () => {
    const { paymentId } = seed('E');

    const result = pay(paymentId, 0);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('positivo');
  });

  test('tres tercos exactos fecham a fatura sem sobrar residuo', () => {
    // 10.000 / 3 nao e redondo: se a comparacao do saldo fosse feita em vírgula
    // flutuante crua, a fatura ficava aberta por 0,000000001.
    const { paymentId } = seed('F', { amountCve: 10000 });

    pay(paymentId, 3333.33);
    pay(paymentId, 3333.33);
    const last = pay(paymentId, 3333.34);

    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.value.settled).toBe(true);
    expect(statusOf(paymentId)).toBe('paid');
  });
});

describe('excesso vira credito do cliente', () => {
  test('quem paga a mais fecha a fatura e fica com o troco a favor', () => {
    const { paymentId, clientId } = seed('G');
    pay(paymentId, 10000);

    const result = pay(paymentId, 45000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.amountCve).toBe(40000); // so o saldo entra na fatura
    expect(result.value.creditAddedCve).toBe(5000);
    expect(result.value.settled).toBe(true);
    expect(payments.clientCreditBalance(db, clientId)).toBe(5000);
  });

  test('o credito abate na fatura seguinte', () => {
    const { paymentId, clientId } = seed('H');
    pay(paymentId, 55000); // 50.000 na fatura + 5.000 de credito

    const next = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      SELECT client_id, service_id, '2026-08', 50000, '2026-08-10', 'pending' FROM payments WHERE id = ?
    `).run(paymentId).lastInsertRowid as number;

    const receipt = payments.applyClientCreditToPayment(db, next);

    expect(receipt?.amountCve).toBe(5000);
    expect(receipt?.source).toBe('credit');
    expect(payments.clientCreditBalance(db, clientId)).toBe(0);
    expect(statusOf(next)).toBe('pending'); // 5.000 nao chegam para os 50.000
    expect(payments.receivedTotal(db, next)).toBe(5000);
  });

  test('sem credito nao inventa recibo nenhum', () => {
    const { paymentId } = seed('I');

    expect(payments.applyClientCreditToPayment(db, paymentId)).toBeNull();
    expect(payments.listPaymentReceipts(db, paymentId)).toHaveLength(0);
  });
});

describe('anular recibo', () => {
  test('reabre a fatura e devolve o numero anterior', () => {
    const { paymentId } = seed('J');
    pay(paymentId, 10000);
    const closing = pay(paymentId, 40000);
    expect(statusOf(paymentId)).toBe('paid');
    if (!closing.ok) return;

    const result = payments.voidReceipt(db, closing.value.receipt.id, 'Lancamento em duplicado no fecho do dia');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reopened).toBe(true);
    expect(result.value.balanceCve).toBe(40000);
    expect(statusOf(paymentId)).toBe('pending');
    // O recibo da fatura recua para o parcial que sobreviveu.
    expect(receiptNumberOf(paymentId)).toBe(payments.listPaymentReceipts(db, paymentId)[0].receiptNumber);
  });

  test('exige motivo detalhado', () => {
    const { paymentId } = seed('K');
    const first = pay(paymentId, 10000);
    if (!first.ok) return;

    const result = payments.voidReceipt(db, first.value.receipt.id, 'erro');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('motivo detalhado');
  });

  test('estorna o credito que o recibo tinha gerado', () => {
    const { paymentId, clientId } = seed('L');
    const over = pay(paymentId, 60000);
    if (!over.ok) return;
    expect(payments.clientCreditBalance(db, clientId)).toBe(10000);

    payments.voidReceipt(db, over.value.receipt.id, 'Valor trocado no lancamento do recibo');

    expect(payments.clientCreditBalance(db, clientId)).toBe(0);
    expect(statusOf(paymentId)).toBe('pending');
  });

  test('o numero fica queimado: anular nao apaga a linha', () => {
    const { paymentId } = seed('M');
    const first = pay(paymentId, 10000);
    if (!first.ok) return;

    payments.voidReceipt(db, first.value.receipt.id, 'Recibo emitido ao cliente errado');

    const receipts = payments.listPaymentReceipts(db, paymentId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].voidedAt).toBeTruthy();
    expect(payments.receivedTotal(db, paymentId)).toBe(0);
  });
});

describe('guardas das saidas existentes', () => {
  test('reverter recusa uma fatura com dinheiro recebido', () => {
    const { paymentId } = seed('N', { invoiceNumber: null as unknown as string });
    pay(paymentId, 10000);

    const result = payments.revertPayment(db, paymentId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('recebimentos');
    expect(db.prepare('SELECT 1 FROM payments WHERE id = ?').get(paymentId)).toBeTruthy();
  });

  test('reverter a cobranca do mes deixa de fora quem ja recebeu', () => {
    const { paymentId } = seed('O', { invoiceNumber: null as unknown as string });
    pay(paymentId, 10000);

    const preview = payments.previewReverseMonthly(db, MONTH);
    expect(preview.eligibleCount).toBe(0);
    expect(preview.invoicedLockedCount).toBe(1);

    payments.executeReverseMonthly(db, MONTH);
    expect(db.prepare('SELECT 1 FROM payments WHERE id = ?').get(paymentId)).toBeTruthy();
  });

  test('anular uma fatura meio recebida exige motivo e devolve o dinheiro a conta corrente', () => {
    const { paymentId, clientId } = seed('P');
    pay(paymentId, 10000);

    const semMotivo = payments.cancelPayment(db, paymentId, 'erro');
    expect(semMotivo.ok).toBe(false);

    const result = payments.cancelPayment(db, paymentId, 'Servico nunca chegou a ser instalado no cliente');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.creditedCve).toBe(10000);
    expect(statusOf(paymentId)).toBe('cancelled');
    expect(payments.clientCreditBalance(db, clientId)).toBe(10000);
  });
});

describe('read model dos pendentes', () => {
  test('conta o saldo, nao o valor da fatura', () => {
    const { paymentId } = seed('Q', { dueDate: '2020-01-10' }); // bem vencida
    pay(paymentId, 10000, '2026-07-15');

    const report = receivables.loadReceivables(db);

    expect(report.totals.openCve).toBe(40000);
    expect(report.totals.overdueCve).toBe(40000);
    expect(report.totals.clients).toBe(1);
    expect(report.clients[0].openCve).toBe(40000);
    expect(report.clients[0].bucket).toBe('d90plus');
  });

  test('fatura saldada sai da lista', () => {
    const { paymentId } = seed('R');
    pay(paymentId);

    expect(receivables.loadReceivables(db).invoices).toHaveLength(0);
  });

  test('fatura anulada nao e divida', () => {
    const { paymentId } = seed('S');
    payments.cancelPayment(db, paymentId, 'Cliente desistiu antes da instalacao');

    expect(receivables.loadReceivables(db).invoices).toHaveLength(0);
  });

  test('classifica pelo dia mais atrasado do cliente', () => {
    const { clientId, paymentId } = seed('T', { dueDate: '2020-01-10' });
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      SELECT client_id, service_id, '2026-08', 2500, date('now', '+5 days'), 'pending' FROM payments WHERE id = ?
    `).run(paymentId);

    const report = receivables.loadReceivables(db);
    const client = report.clients.find((c) => c.clientId === clientId)!;

    expect(client.invoices).toBe(2);
    expect(client.bucket).toBe('d90plus');
    expect(client.openCve).toBe(52500);
    expect(client.overdueCve).toBe(50000); // a que ainda nao venceu nao e atraso
    expect(report.aging.current.invoices).toBe(1);
    expect(report.aging.d90plus.invoices).toBe(1);
  });
});
