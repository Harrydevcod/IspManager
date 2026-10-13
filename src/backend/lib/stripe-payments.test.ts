/**
 * Stripe como via de pagamento: o que interessa é o dinheiro não se perder nem
 * se contar duas vezes. Cada teste olha para o que fica na fatura, na
 * tesouraria e no serviço — com um Stripe falso, sem rede.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { StripeInvoice, StripePaymentInfo, StripeRefund, StripeTransport } from './stripe';
import { createStripeTransport } from './stripe';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let stripePayments: typeof import('./stripe-payments');
let payments: typeof import('./payments');
let treasury: typeof import('./treasury');
let secrets: typeof import('./secrets');
let accountId: number;

const MONTH = '2026-07';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-stripe-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // corre as migrações
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  stripePayments = await import('./stripe-payments');
  payments = await import('./payments');
  treasury = await import('./treasury');
  secrets = await import('./secrets');
});

beforeEach(() => {
  // Filhos primeiro (foreign_keys ON).
  db.prepare('DELETE FROM stripe_payment_links').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM treasury_movements').run();
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payment_lines').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM service_events').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM treasury_accounts').run();
  db.prepare(`DELETE FROM app_settings WHERE key LIKE 'stripe%'`).run();

  const account = treasury.createAccount(db, { kind: 'banco', name: 'Stripe', openingDate: `${MONTH}-01` });
  if (!account.ok) throw new Error(account.error);
  accountId = account.value.id;
  setSetting('stripeEnabled', 'true');
  setSetting('stripeTreasuryAccountId', String(accountId));
  secrets.writeSecret(db, 'stripeSecretKey', 'rk_test_ispm');
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

afterEach(() => { vi.unstubAllGlobals(); });

function setSetting(key: string, value: string) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function seed(code: string, amountCve = 2500) {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, email, status) VALUES (?, ?, ?, 'active')
  `).run(code, `Cliente ${code}`, `cliente-${code}@example.invalid`).lastInsertRowid as number;
  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status, pppoe_username)
    VALUES (?, ?, 10, 'active', ?)
  `).run(clientId, amountCve, `skn${code}`).lastInsertRowid as number;
  const paymentId = db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, invoice_date)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(clientId, serviceId, MONTH, amountCve, `${MONTH}-10`, `FT-2026-000${code}`, `${MONTH}-01`).lastInsertRowid as number;
  return { clientId, serviceId, paymentId };
}

/** Stripe em memória: guarda as faturas e conta as chamadas. */
function fakeStripe() {
  const invoices = new Map<string, StripeInvoice & { amountDue: number; metadata: Record<string, string> }>();
  const calls = { createCustomer: 0, createInvoice: 0, getInvoice: 0, voidInvoice: 0, getInvoicePayment: 0, refundPayment: 0 };
  /** O que o Stripe responde sobre a comissão; por omissão ainda não a tem. */
  let payment: StripePaymentInfo = { paymentIntentId: 'pi_1', fee: null };
  let refundFails = false;
  let refundStatus: StripeRefund['status'] = 'succeeded';
  let creationGate: Promise<void> | undefined;
  let down = false;
  const offline = { ok: false as const, reason: 'Nao foi possivel contactar o Stripe' };

  const transport: StripeTransport = {
    async createCustomer(_input, key) {
      calls.createCustomer += 1;
      return down ? offline : { ok: true, value: { id: `cus_${key}` } };
    },
    async createInvoice(input, key, onDraftCreated) {
      calls.createInvoice += 1;
      if (down) return offline;
      const id = input.invoiceId ?? `in_${key}`;
      onDraftCreated?.(id);
      if (creationGate) await creationGate;
      const invoice = { id, status: 'open', url: `https://invoice.stripe.com/i/${id}`, amountPaid: 0, paidAt: null, amountDue: input.amountMinor, metadata: input.metadata };
      invoices.set(id, invoice);
      return { ok: true, value: invoice };
    },
    async getInvoice(id) {
      calls.getInvoice += 1;
      const invoice = invoices.get(id);
      return down || !invoice ? offline : { ok: true, value: invoice };
    },
    async voidInvoice(id) {
      calls.voidInvoice += 1;
      const invoice = invoices.get(id);
      if (down || !invoice) return offline;
      invoice.status = 'void';
      return { ok: true, value: invoice };
    },
    async getInvoicePayment() {
      calls.getInvoicePayment += 1;
      return down ? offline : { ok: true, value: payment };
    },
    async refundPayment(_intent, key) {
      calls.refundPayment += 1;
      return down || refundFails ? { ok: false, reason: 'O Stripe nao conseguiu fazer o reembolso' } : { ok: true, value: { id: `re_${key}`, status: refundStatus } };
    },
    async getRefund(id) {
      return down ? offline : { ok: true, value: { id, status: refundStatus } };
    }
  };

  return {
    transport,
    calls,
    invoices,
    setDown(value: boolean) { down = value; },
    setPayment(value: StripePaymentInfo) { payment = value; },
    setRefundFails(value: boolean) { refundFails = value; },
    setRefundStatus(value: StripeRefund['status']) { refundStatus = value; },
    pauseCreation(gate: Promise<void>) { creationGate = gate; },
    /** O cliente pagou na página do Stripe. */
    pay(id: string) {
      const invoice = invoices.get(id)!;
      invoice.status = 'paid';
      invoice.amountPaid = invoice.amountDue;
      invoice.paidAt = Math.floor(Date.now() / 1000);
    }
  };
}

const receiptsOf = (paymentId: number) => payments.listPaymentReceipts(db, paymentId);
const statusOf = (paymentId: number) =>
  (db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId) as { status: string }).status;
const linksOf = (paymentId: number) =>
  db.prepare('SELECT status, amount_cve AS amountCve FROM stripe_payment_links WHERE payment_id = ? ORDER BY id').all(paymentId) as Array<{ status: string; amountCve: number }>;

async function openLink(stripe: ReturnType<typeof fakeStripe>, paymentId: number) {
  const link = await stripePayments.ensurePaymentLink(db, paymentId, stripe.transport);
  if (!link.ok) throw new Error(link.error);
  return link.value;
}

describe('link de pagamento', () => {
  test.each([null, '', '   ', 'email-invalido'])('email %s recusa antes de criar objetos; preencher a ficha permite repetir', async (email) => {
    const stripe = fakeStripe();
    const { clientId, paymentId } = seed('55');
    db.prepare('UPDATE clients SET email=? WHERE id=?').run(email, clientId);
    expect(await stripePayments.ensurePaymentLink(db, paymentId, stripe.transport)).toMatchObject({
      ok: false, status: 400, error: expect.stringMatching(/e-mail.*cliente/i)
    });
    expect(stripe.calls.createCustomer).toBe(0);
    expect(stripe.calls.createInvoice).toBe(0);
    expect(linksOf(paymentId)).toEqual([]);
    db.prepare('UPDATE clients SET email=? WHERE id=?').run('cliente-55@example.invalid', clientId);
    expect(await stripePayments.ensurePaymentLink(db, paymentId, stripe.transport)).toMatchObject({
      ok: true, value: { status: 'open' }
    });
  });

  test.each(['pedido', 'sondagem'])('%s recupera após reinício a eliminação sem resposta usando a prova persistida', async (mode) => {
    const { clientId, paymentId } = seed('53');
    db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').run('cus_saved', clientId);
    db.prepare(`INSERT INTO stripe_payment_links (payment_id, stripe_invoice_id, amount_cve)
      VALUES (?, 'in_interrupted', 2500)`).run(paymentId);
    let exists = true;
    let offline = false;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (offline) throw new TypeError('Connection lost');
      if (options.method === 'DELETE') {
        exists = false;
        offline = true;
        throw new TypeError('Connection lost after deleting invoice');
      }
      return exists
        ? new Response(JSON.stringify({ id: 'in_interrupted', status: 'draft', amount_paid: 0 }))
        : new Response(JSON.stringify({ error: { code: 'resource_missing', param: 'id' } }), { status: 404 });
    }));
    expect(payments.payPayment(db, paymentId, { paymentMethod: 'outro', accountId, amountCve: 1000, paymentDate: `${MONTH}-15` })).toMatchObject({ ok: true });
    expect(await stripePayments.ensurePaymentLink(db, paymentId, createStripeTransport('sk_test_placeholder'))).toMatchObject({ ok: false });
    const proof = db.prepare('SELECT draft_cancel_key_hash AS keyHash FROM stripe_payment_links WHERE payment_id = ?').get(paymentId) as { keyHash: string };
    expect(proof.keyHash).toMatch(/^[a-f0-9]{64}$/);
    offline = false;
    const restarted = createStripeTransport('sk_test_placeholder');
    if (mode === 'sondagem') {
      expect(await stripePayments.runStripeSweep(db, restarted)).toMatchObject({ voided: 1, errors: 0 });
    } else {
      // A fatura antiga desapareceu; a criação da nova falha neste HTTP simulado.
      // A compensação confirmada já deve ter libertado o link anterior.
      await stripePayments.ensurePaymentLink(db, paymentId, restarted);
    }
    expect(linksOf(paymentId)[0]).toEqual({ status: 'void', amountCve: 2500 });
    expect(receiptsOf(paymentId)).toHaveLength(1);
    expect(treasury.accountBalance(db, accountId)).toBe(1000);
  });

  test.each(['pedido', 'sondagem'])('%s cancela o rascunho interrompido e permite cobrar apenas o novo saldo', async (mode) => {
    const { clientId, paymentId } = seed('52');
    db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').run('cus_saved', clientId);
    db.prepare(`INSERT INTO stripe_payment_links (payment_id, stripe_invoice_id, amount_cve)
      VALUES (?, 'in_interrupted', 2500)`).run(paymentId);
    let draftExists = true;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const endpoint = new URL(String(url)).pathname;
      const jsonResponse = (value: unknown) => new Response(JSON.stringify(value));
      if (endpoint === '/v1/invoices/in_interrupted' && options.method === 'GET' && draftExists) {
        return jsonResponse({ id: 'in_interrupted', status: 'draft', amount_paid: 0 });
      }
      if (endpoint === '/v1/invoices/in_interrupted' && options.method === 'DELETE' && draftExists) {
        draftExists = false;
        return jsonResponse({ id: 'in_interrupted', object: 'invoice', deleted: true });
      }
      if (endpoint === '/v1/invoices' && options.method === 'POST') {
        return jsonResponse({ id: 'in_replacement', status: 'draft', amount_paid: 0 });
      }
      if (endpoint === '/v1/invoiceitems' && options.method === 'POST') {
        expect(new URLSearchParams(options.body).get('amount')).toBe('150000');
        return jsonResponse({ id: 'ii_replacement' });
      }
      if (endpoint === '/v1/invoices/in_replacement/finalize' && options.method === 'POST') {
        return jsonResponse({ id: 'in_replacement', status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/i/replacement', amount_paid: 0 });
      }
      return new Response(JSON.stringify({ error: { message: 'Invalid invoice operation' } }), { status: 400 });
    }));
    const transport = createStripeTransport('sk_test_placeholder');
    expect(payments.payPayment(db, paymentId, { paymentMethod: 'outro', accountId, amountCve: 1000, paymentDate: `${MONTH}-15` })).toMatchObject({ ok: true });

    if (mode === 'sondagem') {
      expect(await stripePayments.runStripeSweep(db, transport)).toMatchObject({ voided: 1, errors: 0 });
    }
    expect(await stripePayments.ensurePaymentLink(db, paymentId, transport)).toMatchObject({
      ok: true, value: { status: 'open', amountCve: 1500, stripeInvoiceId: 'in_replacement' }
    });
    expect(linksOf(paymentId)).toEqual([{ status: 'void', amountCve: 2500 }, { status: 'open', amountCve: 1500 }]);
    expect(receiptsOf(paymentId)).toHaveLength(1);
    expect(treasury.accountBalance(db, accountId)).toBe(1000);
  });

  test('criacao concorrente com saldo alterado compensa a remota antiga sem ressuscitar a linha', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('51');
    let release!: () => void;
    stripe.pauseCreation(new Promise<void>((resolve) => { release = resolve; }));
    const first = stripePayments.ensurePaymentLink(db, paymentId, stripe.transport);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stripePayments.latestStripeLink(db, paymentId)?.stripeInvoiceId).toBeTruthy();
    payments.payPayment(db, paymentId, { paymentMethod: 'outro', accountId, amountCve: 1000, paymentDate: `${MONTH}-15` });
    const second = stripePayments.ensurePaymentLink(db, paymentId, stripe.transport);
    const sweep = stripePayments.runStripeSweep(db, stripe.transport);
    release();
    expect(await first).toMatchObject({ ok: false, status: 409 });
    expect(await second).toMatchObject({ ok: true, value: { amountCve: 1500, status: 'open' } });
    await sweep;
    expect([...stripe.invoices.values()].filter((invoice) => invoice.status === 'open')).toHaveLength(1);
    expect(linksOf(paymentId).map((link) => link.status)).toEqual(['void', 'open']);
  });
  test('cria o cliente e a fatura no Stripe com o PPPoE no metadata, em centavos', async () => {
    const stripe = fakeStripe();
    const { paymentId, clientId } = seed('1');

    const link = await openLink(stripe, paymentId);

    expect(link.status).toBe('open');
    expect(link.url).toContain('https://invoice.stripe.com/');
    const invoice = stripe.invoices.get(link.stripeInvoiceId!)!;
    expect(invoice.amountDue).toBe(250000);
    expect(invoice.metadata).toMatchObject({ ispmPaymentId: String(paymentId), pppoeUsername: 'skn1', invoiceNumber: 'FT-2026-0001' });
    const stored = db.prepare('SELECT stripe_customer_id AS id FROM clients WHERE id = ?').get(clientId) as { id: string };
    expect(stored.id).toBe(`cus_ispm-customer-${clientId}`);
  });

  test('pedir outra vez devolve o mesmo link e não volta ao Stripe', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('2');

    const first = await openLink(stripe, paymentId);
    const second = await openLink(stripe, paymentId);

    expect(second.id).toBe(first.id);
    expect(stripe.calls.createInvoice).toBe(1);
    expect(stripe.calls.createCustomer).toBe(1);
  });

  test('Stripe em baixo: a tentativa seguinte repete com a mesma chave, sem segunda linha', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('3');

    stripe.setDown(true);
    const failed = await stripePayments.ensurePaymentLink(db, paymentId, stripe.transport);
    expect(failed.ok).toBe(false);
    expect(linksOf(paymentId)).toEqual([{ status: 'creating', amountCve: 2500 }]);

    stripe.setDown(false);
    const link = await openLink(stripe, paymentId);
    expect(linksOf(paymentId)).toEqual([{ status: 'open', amountCve: 2500 }]);
    expect(link.stripeInvoiceId).toBe(`in_ispm-link-${link.id}`);
  });

  test('desligado nas Configurações recusa e não toca no Stripe', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('4');
    setSetting('stripeEnabled', 'false');

    const result = await stripePayments.ensurePaymentLink(db, paymentId, stripe.transport);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(stripe.calls.createInvoice).toBe(0);
    expect(await stripePayments.runStripeSweep(db, stripe.transport)).toMatchObject({ skipped: true });
  });

  test('um recibo parcial anula o link antigo e o novo cobra só o saldo', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('5');
    const old = await openLink(stripe, paymentId);

    payments.payPayment(db, paymentId, { paymentMethod: 'outro', accountId, amountCve: 1000, paymentDate: `${MONTH}-15` });
    const fresh = await openLink(stripe, paymentId);

    expect(stripe.invoices.get(old.stripeInvoiceId!)!.status).toBe('void');
    expect(fresh.amountCve).toBe(1500);
    expect(linksOf(paymentId).map((l) => l.status)).toEqual(['void', 'open']);
  });
});

describe('passagem do Stripe', () => {
  test('uma falha de leitura nunca cancela um link válido com prova de tentativa antiga', async () => {
    const { paymentId } = seed('54');
    db.prepare(`INSERT INTO stripe_payment_links
      (payment_id, stripe_invoice_id, amount_cve, status, draft_cancel_key_hash)
      VALUES (?, 'in_valid', 2500, 'open', 'old-proof')`).run(paymentId);
    let firstRead = true;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (options.method === 'GET' && firstRead) {
        firstRead = false;
        throw new TypeError('Temporary connection loss');
      }
      return new Response(JSON.stringify({
        id: 'in_valid', status: options.method === 'POST' ? 'void' : 'open', amount_paid: 0
      }));
    }));
    expect(await stripePayments.runStripeSweep(db, createStripeTransport('sk_test_placeholder')))
      .toMatchObject({ errors: 1, voided: 0 });
    expect(linksOf(paymentId)).toEqual([{ status: 'open', amountCve: 2500 }]);
  });

  test('pago no Stripe: recibo, tesouraria na conta do Stripe e serviço cortado por dívida reativado', async () => {
    const stripe = fakeStripe();
    const { paymentId, serviceId } = seed('6');
    db.prepare(`UPDATE services SET status = 'suspended', suspension_source = 'nonpayment' WHERE id = ?`).run(serviceId);
    const link = await openLink(stripe, paymentId);
    stripe.pay(link.stripeInvoiceId!);

    const run = await stripePayments.runStripeSweep(db, stripe.transport);

    expect(run).toMatchObject({ paid: 1, errors: 0, review: 0 });
    expect(statusOf(paymentId)).toBe('paid');
    const [receipt] = receiptsOf(paymentId);
    expect(receipt).toMatchObject({ amountCve: 2500, paymentMethod: 'outro', accountId, notes: `Stripe ${link.stripeInvoiceId}` });
    expect(treasury.accountBalance(db, accountId)).toBe(2500);
    expect((db.prepare('SELECT status FROM services WHERE id = ?').get(serviceId) as { status: string }).status).toBe('active');
    expect(linksOf(paymentId)).toEqual([{ status: 'paid', amountCve: 2500 }]);
  });

  test('uma segunda passagem não dobra o recibo', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('7');
    const link = await openLink(stripe, paymentId);
    stripe.pay(link.stripeInvoiceId!);

    await stripePayments.runStripeSweep(db, stripe.transport);
    const again = await stripePayments.runStripeSweep(db, stripe.transport);

    expect(again).toMatchObject({ paid: 0, checked: 0 });
    expect(receiptsOf(paymentId)).toHaveLength(1);
    expect(treasury.accountBalance(db, accountId)).toBe(2500);
  });

  test('pago em numerário entretanto: o link morre no Stripe', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('8');
    const link = await openLink(stripe, paymentId);
    payments.payPayment(db, paymentId, { paymentMethod: 'outro', accountId, paymentDate: `${MONTH}-15` });

    const run = await stripePayments.runStripeSweep(db, stripe.transport);

    expect(run).toMatchObject({ voided: 1, paid: 0 });
    expect(stripe.invoices.get(link.stripeInvoiceId!)!.status).toBe('void');
    expect(receiptsOf(paymentId)).toHaveLength(1);
  });

  test('pago nos dois lados: fica para revisão, sem recibo inventado', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('9');
    const link = await openLink(stripe, paymentId);
    payments.payPayment(db, paymentId, { paymentMethod: 'outro', accountId, paymentDate: `${MONTH}-15` });
    stripe.pay(link.stripeInvoiceId!);

    const run = await stripePayments.runStripeSweep(db, stripe.transport);

    expect(run).toMatchObject({ review: 1, paid: 0, voided: 0 });
    expect(linksOf(paymentId)).toEqual([{ status: 'review', amountCve: 2500 }]);
    expect(receiptsOf(paymentId)).toHaveLength(1);
    expect(stripe.calls.voidInvoice).toBe(0);
  });

  test('Stripe em baixo: nada muda e o link continua aberto', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('10');
    const link = await openLink(stripe, paymentId);
    stripe.pay(link.stripeInvoiceId!);
    stripe.setDown(true);

    const run = await stripePayments.runStripeSweep(db, stripe.transport);

    expect(run).toMatchObject({ errors: 1, paid: 0 });
    expect(statusOf(paymentId)).toBe('pending');
    expect(linksOf(paymentId)).toEqual([{ status: 'open', amountCve: 2500 }]);
  });

  test('conta de destino desativada: a passagem salta e retoma quando se corrige', async () => {
    const stripe = fakeStripe();
    const { paymentId } = seed('11');
    const link = await openLink(stripe, paymentId);
    stripe.pay(link.stripeInvoiceId!);
    const other = treasury.createAccount(db, { kind: 'banco', name: 'Outro banco' });
    if (!other.ok) throw new Error(other.error);
    // Aponta para uma conta que deixou de existir sem desligar o Stripe.
    db.prepare('UPDATE treasury_accounts SET active = 0 WHERE id = ?').run(accountId);

    const blocked = await stripePayments.runStripeSweep(db, stripe.transport);
    expect(blocked).toMatchObject({ skipped: true });
    expect(receiptsOf(paymentId)).toHaveLength(0);

    setSetting('stripeTreasuryAccountId', String(other.value.id));
    const run = await stripePayments.runStripeSweep(db, stripe.transport);
    expect(run).toMatchObject({ paid: 1 });
    expect(treasury.accountBalance(db, other.value.id)).toBe(2500);
  });
});

const expensesOf = () =>
  db.prepare('SELECT category, description, amount_cve AS amountCve, supplier, account_id AS accountId FROM expenses ORDER BY id').all() as Array<{
    category: string; description: string; amountCve: number; supplier: string; accountId: number;
  }>;

async function paidLink(stripe: ReturnType<typeof fakeStripe>, code: string) {
  const seeded = seed(code);
  const link = await openLink(stripe, seeded.paymentId);
  stripe.pay(link.stripeInvoiceId!);
  return { ...seeded, link };
}

describe('comissão do Stripe', () => {
  test('comissao tardia debita a conta original do recibo mesmo apos mudar a configuracao', async () => {
    const stripe = fakeStripe();
    await paidLink(stripe, '52');
    await stripePayments.runStripeSweep(db, stripe.transport);
    const other = treasury.createAccount(db, { kind: 'banco', name: 'Stripe novo' });
    if (!other.ok) throw new Error(other.error);
    setSetting('stripeTreasuryAccountId', String(other.value.id));
    stripe.setPayment({ paymentIntentId: 'pi_1', fee: { amountMinor: 5000, currency: 'cve', exchangeRate: null } });
    await stripePayments.runStripeSweep(db, stripe.transport);
    expect(expensesOf()[0].accountId).toBe(accountId);
    expect(treasury.accountBalance(db, accountId)).toBe(2450);
    expect(treasury.accountBalance(db, other.value.id)).toBe(0);
  });
  test('liquidada em euros: vira despesa em escudos na conta do Stripe e o saldo fica o líquido', async () => {
    const stripe = fakeStripe();
    // 2.500 CVE cobrados; o Stripe ficou com 0,91 EUR a um câmbio de 0,00907 EUR por escudo.
    stripe.setPayment({ paymentIntentId: 'pi_1', fee: { amountMinor: 91, currency: 'eur', exchangeRate: 0.00907 } });
    await paidLink(stripe, '20');

    const run = await stripePayments.runStripeSweep(db, stripe.transport);

    expect(run).toMatchObject({ paid: 1, fees: 1, errors: 0 });
    expect(expensesOf()).toEqual([
      { category: 'outros', description: 'Comissão Stripe · FT-2026-00020', amountCve: 100.33, supplier: 'Stripe', accountId }
    ]);
    expect(treasury.accountBalance(db, accountId)).toBe(2399.67);
  });

  test('ainda por apurar: tenta na passagem seguinte e a despesa nunca dobra', async () => {
    const stripe = fakeStripe();
    await paidLink(stripe, '21');

    expect(await stripePayments.runStripeSweep(db, stripe.transport)).toMatchObject({ paid: 1, fees: 0 });
    expect(expensesOf()).toHaveLength(0);

    stripe.setPayment({ paymentIntentId: 'pi_1', fee: { amountMinor: 5000, currency: 'cve', exchangeRate: null } });
    expect(await stripePayments.runStripeSweep(db, stripe.transport)).toMatchObject({ fees: 1 });
    expect(await stripePayments.runStripeSweep(db, stripe.transport)).toMatchObject({ fees: 0 });

    expect(expensesOf()).toHaveLength(1);
    expect(expensesOf()[0].amountCve).toBe(50);
  });

  test('fatura dada como paga sem cartão não tem comissão nem despesa', async () => {
    const stripe = fakeStripe();
    stripe.setPayment({ paymentIntentId: null, fee: null });
    await paidLink(stripe, '22');

    await stripePayments.runStripeSweep(db, stripe.transport);
    const calls = stripe.calls.getInvoicePayment;
    await stripePayments.runStripeSweep(db, stripe.transport);

    expect(expensesOf()).toHaveLength(0);
    // Apurada como zero: não se volta a perguntar.
    expect(stripe.calls.getInvoicePayment).toBe(calls);
  });
});

describe('reembolso', () => {
  const REASON = 'Cliente pagou a fatura errada';
  test.each(['pending', 'requires_action'] as const)('%s conserva recibo e saldo ate succeeded e nao duplica estorno', async (status) => {
    const stripe = fakeStripe();
    const { paymentId } = await paidLink(stripe, '53');
    await stripePayments.runStripeSweep(db, stripe.transport);
    const [receipt] = receiptsOf(paymentId);
    stripe.setRefundStatus(status);
    expect(await stripePayments.refundStripeReceipt(db, receipt.id, REASON, null, stripe.transport)).toMatchObject({ ok: true, value: { status } });
    expect(statusOf(paymentId)).toBe('paid');
    expect(treasury.accountBalance(db, accountId)).toBe(2500);
    expect(linksOf(paymentId)[0].status).toBe('refund_pending');
    expect(await stripePayments.refundStripeReceipt(db, receipt.id, REASON, null, stripe.transport)).toMatchObject({ ok: false });
    await stripePayments.runStripeSweep(db, stripe.transport);
    expect(statusOf(paymentId)).toBe('paid');
    stripe.setRefundStatus('succeeded');
    await Promise.all([stripePayments.runStripeSweep(db, stripe.transport), stripePayments.runStripeSweep(db, stripe.transport)]);
    expect(statusOf(paymentId)).toBe('pending');
    expect(treasury.accountBalance(db, accountId)).toBe(0);
    expect(stripe.calls.refundPayment).toBe(1);
    expect(receiptsOf(paymentId)[0].voidReason).toContain(REASON);
    expect(linksOf(paymentId)[0].status).toBe('refunded');
  });
  test.each(['failed', 'canceled'] as const)('pedido pendente que termina %s fica em revisao com divida paga', async (status) => {
    const stripe = fakeStripe();
    const { paymentId } = await paidLink(stripe, '54');
    await stripePayments.runStripeSweep(db, stripe.transport);
    const [receipt] = receiptsOf(paymentId);
    stripe.setRefundStatus('pending');
    await stripePayments.refundStripeReceipt(db, receipt.id, REASON, null, stripe.transport);
    stripe.setRefundStatus(status);
    await stripePayments.runStripeSweep(db, stripe.transport);
    expect(linksOf(paymentId)[0].status).toBe('review');
    expect(statusOf(paymentId)).toBe('paid');
    expect(treasury.accountBalance(db, accountId)).toBe(2500);
    expect(db.prepare("SELECT id FROM audit_logs WHERE action = 'stripe_refund_needs_review' AND entity_id = ?").get(String(paymentId))).toBeTruthy();
  });

  test('aceite pelo Stripe: recibo anulado, tesouraria a zero, fatura reaberta', async () => {
    const stripe = fakeStripe();
    const { paymentId, link } = await paidLink(stripe, '30');
    await stripePayments.runStripeSweep(db, stripe.transport);
    const [receipt] = receiptsOf(paymentId);

    const result = await stripePayments.refundStripeReceipt(db, receipt.id, REASON, null, stripe.transport);

    expect(result).toMatchObject({ ok: true, value: { refundId: `re_ispm-refund-${link.id}` } });
    expect(statusOf(paymentId)).toBe('pending');
    expect(receiptsOf(paymentId)[0].voidReason).toContain('Reembolso Stripe re_ispm-refund-');
    expect(treasury.accountBalance(db, accountId)).toBe(0);
    expect(linksOf(paymentId)).toEqual([{ status: 'refunded', amountCve: 2500 }]);
    expect(stripePayments.refundableReceiptIds(db, paymentId)).toEqual([]);
  });

  test('um segundo pedido é recusado sem voltar ao Stripe', async () => {
    const stripe = fakeStripe();
    const { paymentId } = await paidLink(stripe, '31');
    await stripePayments.runStripeSweep(db, stripe.transport);
    const [receipt] = receiptsOf(paymentId);
    await stripePayments.refundStripeReceipt(db, receipt.id, REASON, null, stripe.transport);

    const again = await stripePayments.refundStripeReceipt(db, receipt.id, REASON, null, stripe.transport);

    expect(again).toMatchObject({ ok: false, status: 404 });
    expect(stripe.calls.refundPayment).toBe(1);
  });

  test('o Stripe recusa: nada muda', async () => {
    const stripe = fakeStripe();
    const { paymentId } = await paidLink(stripe, '32');
    await stripePayments.runStripeSweep(db, stripe.transport);
    const [receipt] = receiptsOf(paymentId);
    stripe.setRefundFails(true);

    const result = await stripePayments.refundStripeReceipt(db, receipt.id, REASON, null, stripe.transport);

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(statusOf(paymentId)).toBe('paid');
    expect(treasury.accountBalance(db, accountId)).toBe(2500);
    expect(stripePayments.refundableReceiptIds(db, paymentId)).toEqual([receipt.id]);
  });

  test('motivo curto ou recibo que não é do Stripe: recusa antes de pedir o reembolso', async () => {
    const stripe = fakeStripe();
    const { paymentId } = await paidLink(stripe, '33');
    await stripePayments.runStripeSweep(db, stripe.transport);
    const [receipt] = receiptsOf(paymentId);
    const cash = seed('34');
    payments.payPayment(db, cash.paymentId, { paymentMethod: 'outro', accountId, paymentDate: `${MONTH}-15` });

    expect(await stripePayments.refundStripeReceipt(db, receipt.id, 'erro', null, stripe.transport)).toMatchObject({ ok: false, status: 400 });
    expect(await stripePayments.refundStripeReceipt(db, receiptsOf(cash.paymentId)[0].id, REASON, null, stripe.transport)).toMatchObject({ ok: false, status: 404 });
    expect(stripe.calls.refundPayment).toBe(0);
  });
});

describe('link nos avisos', () => {
  const linkFor = (paymentId: number) =>
    (db.prepare(`SELECT ${stripePayments.openStripeLinkSql('py')} AS url FROM payments py WHERE py.id = ?`).get(paymentId) as { url: string | null }).url;

  test('só a fatura com link aberto do valor certo o leva', async () => {
    const stripe = fakeStripe();
    const withLink = seed('40');
    const without = seed('41');
    const link = await openLink(stripe, withLink.paymentId);

    expect(linkFor(withLink.paymentId)).toBe(link.url);
    expect(linkFor(without.paymentId)).toBeNull();

    // Um recibo parcial muda o saldo: o link antigo cobrava a mais e deixa de ir.
    payments.payPayment(db, withLink.paymentId, { paymentMethod: 'outro', accountId, amountCve: 1000, paymentDate: `${MONTH}-15` });
    expect(linkFor(withLink.paymentId)).toBeNull();
  });
});
