/**
 * Fatura manual: o que se escreve à mão tem de se comportar como qualquer
 * outra dívida — numerada, cobrável, visível nas contas — com ou sem serviço,
 * e também para quem ainda não era cliente.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ManualInvoiceInput } from './manual-invoice';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let manual: typeof import('./manual-invoice');
let payments: typeof import('./payments');
let treasury: typeof import('./treasury');
let receivables: typeof import('./receivables');
let autoSuspension: typeof import('./auto-suspension');
let documents: typeof import('./documents');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-manual-invoice-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // corre as migrações
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  manual = await import('./manual-invoice');
  payments = await import('./payments');
  treasury = await import('./treasury');
  receivables = await import('./receivables');
  autoSuspension = await import('./auto-suspension');
  documents = await import('./documents');
});

beforeEach(() => {
  // Filhos primeiro (foreign_keys ON).
  db.prepare('DELETE FROM stripe_payment_links').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM treasury_movements').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payment_lines').run();
  db.prepare('DELETE FROM articles').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM service_events').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM treasury_accounts').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function seedClient(code: string, { withService = true, pppoe = false } = {}) {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status, nif) VALUES (?, ?, 'active', ?)
  `).run(code, `Cliente ${code}`, `2${code.replace(/\D/g, '').padStart(8, '0')}`).lastInsertRowid as number;
  const serviceId = withService
    ? db.prepare(`
        INSERT INTO services (client_id, monthly_value_cve, due_day, status, pppoe_username)
        VALUES (?, 2500, 10, 'active', ?)
      `).run(clientId, pppoe ? `skn${code}` : null).lastInsertRowid as number
    : null;
  return { clientId, serviceId };
}

const lines = [
  { description: 'Deslocação técnica', amountCve: 1500 },
  { description: 'Cabo de rede 20 m', amountCve: 800.5 }
];

function create(input: Partial<ManualInvoiceInput>) {
  return manual.createManualInvoice(db, { lines, ...input } as ManualInvoiceInput, null);
}

function mustCreate(input: Partial<ManualInvoiceInput>) {
  const result = create(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const paymentRow = (id: number) => db.prepare(`
  SELECT client_id AS clientId, service_id AS serviceId, reference_month AS referenceMonth,
         amount_cve AS amountCve, status, invoice_number AS invoiceNumber, invoice_date AS invoiceDate, due_date AS dueDate
  FROM payments WHERE id = ?
`).get(id) as Record<string, unknown>;

describe('emitir', () => {
  test('para um cliente com serviço: numerada, com as linhas escritas e a chave própria', () => {
    const { clientId, serviceId } = seedClient('1');

    const invoice = mustCreate({ clientId, serviceId });

    expect(invoice.invoiceNumber).toMatch(/^FT-\d{4}-\d{5}$/);
    expect(invoice.amountCve).toBe(2300.5);
    expect(paymentRow(invoice.paymentId)).toMatchObject({
      clientId, serviceId, referenceMonth: `AVULSA-${invoice.paymentId}`, amountCve: 2300.5, status: 'pending'
    });
    expect(db.prepare('SELECT kind, description, amount_cve AS amountCve FROM payment_lines WHERE payment_id = ? ORDER BY sort_order').all(invoice.paymentId))
      .toEqual([
        { kind: 'avulso', description: 'Deslocação técnica', amountCve: 1500 },
        { kind: 'avulso', description: 'Cabo de rede 20 m', amountCve: 800.5 }
      ]);
  });

  test('o mesmo serviço pode ter várias, com números seguidos', () => {
    const { clientId, serviceId } = seedClient('2');

    const first = mustCreate({ clientId, serviceId });
    const second = mustCreate({ clientId, serviceId });

    const seq = (n: string) => Number(n.split('-')[2]);
    expect(seq(second.invoiceNumber)).toBe(seq(first.invoiceNumber) + 1);
  });

  test('para um cliente sem serviço', () => {
    const { clientId } = seedClient('3', { withService: false });

    const invoice = mustCreate({ clientId });

    expect(paymentRow(invoice.paymentId)).toMatchObject({ clientId, serviceId: null });
    expect(invoice.clientCreated).toBe(false);
  });

  test('para quem não é cliente: regista o destinatário sem serviço', () => {
    seedClient('4');

    const invoice = mustCreate({ newClient: { fullName: 'Loja do Porto', nif: '250000001', phone: '9911122', address: 'Rua 1' } });

    expect(invoice.clientCreated).toBe(true);
    const client = db.prepare('SELECT full_name AS name, nif, client_code AS code, status FROM clients WHERE id = ?').get(invoice.clientId);
    expect(client).toEqual({ name: 'Loja do Porto', nif: '250000001', code: 'C0002', status: 'active' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM services WHERE client_id = ?').get(invoice.clientId)).toEqual({ n: 0 });
  });

  test('datas escolhidas no formulário; por omissão vence 30 dias depois da emissão', () => {
    const { clientId } = seedClient('5');

    const dated = mustCreate({ clientId, invoiceDate: '2026-09-01', dueDate: '2026-09-15' });
    const defaulted = mustCreate({ clientId, invoiceDate: '2026-09-01' });

    expect(paymentRow(dated.paymentId)).toMatchObject({ invoiceDate: '2026-09-01', dueDate: '2026-09-15' });
    expect(paymentRow(defaulted.paymentId)).toMatchObject({ dueDate: '2026-10-01' });
  });

  test('crédito que o cliente já tinha abate logo', () => {
    const { clientId } = seedClient('6', { withService: false });
    db.prepare(`INSERT INTO client_credits (client_id, amount_cve, reason) VALUES (?, 300.5, 'Troco')`).run(clientId);

    const invoice = mustCreate({ clientId });

    expect(payments.receivedTotal(db, invoice.paymentId)).toBe(300.5);
    expect(payments.clientCreditBalance(db, clientId)).toBe(0);
  });

  test('o total corresponde à soma das linhas arredondadas ao centavo', () => {
    const { clientId } = seedClient('7', { withService: false });
    const invoice = mustCreate({ clientId, lines: [
      { description: 'Cabo', amountCve: 10.006 },
      { description: 'Ficha', amountCve: 10.006 }
    ] });

    expect(invoice.amountCve).toBe(20.02);
    expect(paymentRow(invoice.paymentId).amountCve).toBe(20.02);
    expect(db.prepare('SELECT sum(amount_cve) AS total FROM payment_lines WHERE payment_id = ?')
      .get(invoice.paymentId)).toEqual({ total: 20.02 });
  });
});

describe('recusas', () => {
  test('sem destinatário, ou com os dois', () => {
    const { clientId } = seedClient('10');
    expect(create({})).toMatchObject({ ok: false, status: 400 });
    expect(create({ clientId, newClient: { fullName: 'X' } })).toMatchObject({ ok: false, status: 400 });
  });

  test('destinatário novo com NIF ou telefone de um cliente que já existe', () => {
    const { clientId } = seedClient('11');
    db.prepare(`UPDATE clients SET phone = '9900011' WHERE id = ?`).run(clientId);

    expect(create({ newClient: { fullName: 'Outro', nif: '200000011' } })).toMatchObject({ ok: false, status: 409 });
    expect(create({ newClient: { fullName: 'Outro', phone: '9900011' } })).toMatchObject({ ok: false, status: 409 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM clients').get()).toEqual({ n: 1 });
  });

  test('serviço de outro cliente, ou cancelado', () => {
    const a = seedClient('12');
    const b = seedClient('13');
    db.prepare(`UPDATE services SET status = 'cancelled' WHERE id = ?`).run(a.serviceId);

    expect(create({ clientId: a.clientId, serviceId: b.serviceId })).toMatchObject({ ok: false, status: 400 });
    expect(create({ clientId: a.clientId, serviceId: a.serviceId })).toMatchObject({ ok: false, status: 400 });
  });

  test('emissão no futuro e vencimento antes da emissão', () => {
    const { clientId } = seedClient('14');
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

    expect(create({ clientId, invoiceDate: tomorrow })).toMatchObject({ ok: false, status: 400 });
    expect(create({ clientId, invoiceDate: '2026-09-10', dueDate: '2026-09-01' })).toMatchObject({ ok: false, status: 400 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 0 });
  });

  test('o esquema recusa linhas vazias, sem valor ou a mais', () => {
    const parse = (value: unknown) => manual.manualInvoiceSchema.safeParse(value).success;
    expect(parse({ clientId: 1, lines: [] })).toBe(false);
    expect(parse({ clientId: 1, lines: [{ description: 'x', amountCve: 0 }] })).toBe(false);
    expect(parse({ clientId: 1, lines: [{ description: '  ', amountCve: 10 }] })).toBe(false);
    expect(parse({ clientId: 1, lines: Array.from({ length: 21 }, () => ({ description: 'x', amountCve: 1 })) })).toBe(false);
    expect(parse({ clientId: 1, lines: [{ description: 'x', amountCve: 10 }] })).toBe(true);
  });

  test('recusa valores abaixo de um centavo ou não finitos e datas inexistentes', () => {
    const parse = (patch: Record<string, unknown>) => manual.manualInvoiceSchema.safeParse({ clientId: 1, lines, ...patch }).success;
    expect(parse({ lines: [{ description: 'x', amountCve: 0.001 }] })).toBe(false);
    expect(parse({ lines: [{ description: 'x', amountCve: Infinity }] })).toBe(false);
    expect(parse({ invoiceDate: '2026-02-30' })).toBe(false);
    expect(parse({ dueDate: '2026-13-01' })).toBe(false);
    expect(parse({ invoiceDate: '2024-02-29' })).toBe(true);
  });

  test('não se regenera: trocava as linhas escritas pelas do plano', () => {
    const { clientId, serviceId } = seedClient('15');
    const invoice = mustCreate({ clientId, serviceId });
    payments.cancelPayment(db, invoice.paymentId, 'Fatura passada por engano');

    expect(payments.regeneratePayment(db, invoice.paymentId)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('é uma dívida como as outras', () => {
  test('sem serviço: aparece nas dívidas, paga-se, entra na tesouraria e tem PDF', async () => {
    const account = treasury.createAccount(db, { kind: 'banco', name: 'Banco' });
    if (!account.ok) throw new Error(account.error);
    const invoice = mustCreate({ newClient: { fullName: 'Loja do Porto' }, invoiceDate: '2026-09-01' });

    const owed = JSON.stringify(receivables.loadReceivables(db));
    expect(owed).toContain('Loja do Porto');

    const paid = payments.payPayment(db, invoice.paymentId, { paymentMethod: 'transferencia', accountId: account.value.id });
    expect(paid).toMatchObject({ ok: true, value: { settled: true } });
    expect(treasury.accountBalance(db, account.value.id)).toBe(2300.5);
    expect(JSON.stringify(receivables.loadReceivables(db))).not.toContain('Loja do Porto');

    const pdf = await documents.renderPaymentDocumentPdf(invoice.paymentId, 'invoice');
    expect(pdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('de um serviço e fora da tolerância conta para o corte; sem serviço não', () => {
    const { clientId, serviceId } = seedClient('20', { pppoe: true });
    const other = seedClient('21', { withService: false });
    const onService = mustCreate({ clientId, serviceId, invoiceDate: '2026-01-01', dueDate: '2026-01-10' });
    mustCreate({ clientId: other.clientId, invoiceDate: '2026-01-01', dueDate: '2026-01-10' });

    const preview = autoSuspension.loadAutoSuspensionPreview(db);

    expect(preview.candidates.map((row) => row.paymentId)).toEqual([onService.paymentId]);
  });
});

test('linhas livres viram serviços com código; o artigo escolhido liga-se sem duplicar', () => {
  const { clientId } = seedClient('C0101', { withService: false });
  const first = create({ clientId });
  if (!first.ok) throw new Error(first.error);
  expect(db.prepare('SELECT code,name,kind FROM articles ORDER BY id').all()).toEqual([
    { code: 'SRV0001', name: 'Deslocação técnica', kind: 'service' },
    { code: 'SRV0002', name: 'Cabo de rede 20 m', kind: 'service' }
  ]);
  const { id } = db.prepare("SELECT id FROM articles WHERE code='SRV0001'").get() as { id: number };
  const second = create({ clientId, lines: [{ description: 'Deslocação técnica', amountCve: 1500, articleId: id }] });
  if (!second.ok) throw new Error(second.error);
  expect(db.prepare('SELECT article_id AS id FROM payment_lines WHERE payment_id=?').all(second.value.paymentId)).toEqual([{ id }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()).toEqual({ n: 2 });
  expect(create({ clientId, lines: [{ description: 'X', amountCve: 1, articleId: 999999 }] })).toMatchObject({ ok: false, status: 409 });
});

test('quantidade × preço unitário: a linha grava código e quantidade e o PDF mostra-os', async () => {
  const { clientId } = seedClient('C0102', { withService: false });
  const result = create({ clientId, lines: [{ description: 'Cabo UTP (metro)', quantity: 2.5, unitPriceCve: 100 }] });
  if (!result.ok) throw new Error(result.error);
  const line = db.prepare('SELECT amount_cve AS amount, quantity, item_code AS code FROM payment_lines WHERE payment_id=?').get(result.value.paymentId) as { amount: number; quantity: number; code: string };
  expect(line).toMatchObject({ amount: 250, quantity: 2.5 });
  expect(line.code).toMatch(/^SRV\d{4}$/);
  // O código fica na linha: editá-lo no catálogo não muda a fatura já emitida.
  db.prepare("UPDATE articles SET code='MUDOU' WHERE code=?").run(line.code);
  const { inspectPdfLayout } = await import('./pdf.testing');
  const text = inspectPdfLayout((await documents.renderPaymentDocumentPdf(result.value.paymentId, 'invoice')).buffer).text.flat().map((t) => t.value);
  for (const value of [line.code, '2,5', '100$00', '250$00', 'QTD.', 'COD.']) expect(text).toContain(value);
  expect(text).not.toContain('MUDOU');
  expect(create({ clientId, lines: [{ description: 'X', quantity: 0, unitPriceCve: 1 }] })).toMatchObject({ ok: false });
});

test('observações: aviso de suspensão só com serviço; nota do artigo e política só com produtos', async () => {
  const { inspectPdfLayout } = await import('./pdf.testing');
  const pdfText = async (paymentId: number) => inspectPdfLayout((await documents.renderPaymentDocumentPdf(paymentId, 'invoice')).buffer)
    .text.flat().map((t) => t.value).join('\n');
  db.prepare("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('productPolicy', 'Trocas em 7 dias.')").run();
  try {
    const product = Number(db.prepare("INSERT INTO articles(code,name,kind,unit_price_cve,document_note) VALUES ('ART0001','Router','product',100,'Garantia 12 meses')").run().lastInsertRowid);
    db.prepare("INSERT INTO articles(code,name,kind,unit_price_cve,document_note) VALUES ('SRV0001','Visita','service',50,NULL)").run();
    const { clientId, serviceId } = seedClient('C0103');

    const sale = mustCreate({ clientId, lines: [{ description: 'Router', quantity: 1, unitPriceCve: 100, articleId: product }] });
    db.prepare("UPDATE articles SET document_note='Mudou' WHERE id=?").run(product);
    const saleText = await pdfText(sale.paymentId);
    expect(saleText).not.toContain('Após a data limite');
    expect(saleText).toContain('ART0001 Router: Garantia 12 meses');
    expect(saleText).toContain('Trocas em 7 dias.');
    expect(saleText).not.toContain('Mudou');

    const visit = mustCreate({ clientId, serviceId, lines: [{ description: 'Visita', quantity: 1, unitPriceCve: 50 }] });
    const visitText = await pdfText(visit.paymentId);
    expect(visitText).toContain('Após a data limite');
    expect(visitText).not.toContain('Trocas em 7 dias.');
  } finally {
    db.prepare("DELETE FROM app_settings WHERE key='productPolicy'").run();
  }
});
