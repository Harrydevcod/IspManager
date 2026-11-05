import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let mod: typeof import('./companion-snapshot');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-companion-snapshot-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  mod = await import('./companion-snapshot');
});

beforeEach(() => {
  for (const table of ['support_tickets', 'work_orders', 'payment_receipts', 'client_credits', 'payments', 'services', 'clients', 'treasury_accounts', 'internet_plans']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare(`DELETE FROM app_settings WHERE key = 'vinti4Enabled'`).run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

// O router nunca é lido nos testes.
const noWans = async () => ({ wans: null, wanReason: 'teste' });
const snapshot = () => mod.buildCompanionSnapshot(db, new Date(), noWans);

let seq = 0;
function client(name: string, phone: string | null, extra: { address?: string; zone?: string } = {}) {
  seq += 1;
  const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status, address, zone) VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`C${seq}`, name, phone, extra.address ?? null, extra.zone ?? null).lastInsertRowid as number;
  const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 2500, 10, 'active')`)
    .run(clientId).lastInsertRowid as number;
  return { clientId, serviceId };
}

/** Fatura com vencimento há `daysAgo` dias (negativo = no futuro). */
function invoice(c: { clientId: number; serviceId: number }, amount: number, daysAgo: number) {
  return db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
    VALUES (?, ?, strftime('%Y-%m', '2000-01-01', ? || ' months'), ?, date('now', ?), 'pending')
  `).run(c.clientId, c.serviceId, String(++seq), amount, `${-daysAgo} days`).lastInsertRowid as number;
}

function receipt(paymentId: number, amount: number, date: string, accountId: number | null, voided = false) {
  seq += 1;
  db.prepare(`
    INSERT INTO payment_receipts (payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date, account_id, voided_at)
    VALUES (?, ?, ?, 'numerario', 'cash', ?, ?, ?, ?)
  `).run(paymentId, amount, date, `RC-${seq}`, date, accountId, voided ? date : null);
}

const today = () => (db.prepare(`SELECT date('now', '-1 hours') AS d`).get() as { d: string }).d;

describe('buildCompanionSnapshot — terreno', () => {
  test('debtors: one row per client, biggest debt first, phone ready to dial', async () => {
    const ana = client('Ana', '991 22 33');
    const rui = client('Rui', '12');
    invoice(ana, 2500, 40);
    invoice(ana, 2500, 10);
    invoice(rui, 9000, 5);
    invoice(client('Futuro', '9911111'), 9999, -3); // ainda não venceu

    const { money } = await snapshot();
    expect(money.debtors.map((d) => [d.clientName, d.amountCve, d.daysOverdue])).toEqual([['Rui', 9000, 5], ['Ana', 5000, 40]]);
    expect(money.debtors[1].phone).toBe('+2389912233');
    expect(money.debtors[0].phone).toBeNull(); // número inválido não se marca
  });

  test('payment link: the newest overdue invoice EasyLink while it still matches the balance', async () => {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('vinti4Enabled', 'true')`).run();
    const ana = client('Ana', '9912233');
    const old = invoice(ana, 2500, 40);
    const recent = invoice(ana, 3000, 10);
    const link = 'https://www.vinti4.cv/pay/abc';
    db.prepare(`UPDATE payments SET vinti4_link_url = ?, vinti4_link_amount_cve = amount_cve WHERE id IN (?, ?)`).run(link, old, recent);

    let debtor = (await snapshot()).money.debtors[0];
    expect([debtor.paymentLink, debtor.paymentLinkAmountCve]).toEqual([link, 3000]);

    // Pago em parte: o link já não é o saldo e deixa de seguir; vale o da fatura anterior.
    receipt(recent, 500, today(), null);
    db.prepare(`UPDATE payments SET vinti4_link_url = ? WHERE id = ?`).run('https://www.vinti4.cv/pay/old', old);
    debtor = (await snapshot()).money.debtors[0];
    expect([debtor.paymentLink, debtor.paymentLinkAmountCve]).toEqual(['https://www.vinti4.cv/pay/old', 2500]);
  });

  test('a debtor without any open link has none', async () => {
    invoice(client('Rui', '9912233'), 2500, 20);
    expect((await snapshot()).money.debtors[0]).toMatchObject({ paymentLink: null, paymentLinkAmountCve: null });
  });

  test('a partly paid invoice counts only what is still owed', async () => {
    const ana = client('Ana', '9912233');
    const id = invoice(ana, 2500, 20);
    receipt(id, 1000, today(), null);
    const { money } = await snapshot();
    expect(money.debtors[0].amountCve).toBe(1500);
  });

  test('cash today: per account, voided receipts and other days left out', async () => {
    const caixa = db.prepare(`INSERT INTO treasury_accounts (kind, name, opening_date) VALUES ('caixa', 'Caixa loja', date('now'))`).run().lastInsertRowid as number;
    const ana = client('Ana', '9912233');
    const id = invoice(ana, 9000, 1);
    receipt(id, 1000, today(), caixa);
    receipt(id, 500, today(), null);
    receipt(id, 700, today(), caixa, true);
    receipt(id, 300, '2020-01-01', caixa);

    const { money } = await snapshot();
    expect(money.cashToday.totalCve).toBe(1500);
    expect(money.cashToday.byAccount).toEqual([{ name: 'Caixa loja', amountCve: 1000 }, { name: 'Sem conta', amountCve: 500 }]);
  });

  test('monthly receipts: always six months, oldest first, empty months at zero', async () => {
    const id = invoice(client('Ana', '9912233'), 9000, 1);
    receipt(id, 1200, today(), null);
    const { money } = await snapshot();
    expect(money.monthlyReceipts).toHaveLength(6);
    expect(money.monthlyReceipts[5]).toEqual({ month: today().slice(0, 7), amountCve: 1200 });
    expect(money.monthlyReceipts.slice(0, 5).every((m) => m.amountCve === 0)).toBe(true);
  });

  test('work: open orders by priority (with and without a client), closed ones left out', async () => {
    const ana = client('Ana', '9912233', { address: 'Rua 1', zone: 'Monte Sossego' });
    db.prepare(`INSERT INTO work_orders (service_id, title, status, priority) VALUES (?, 'Trocar antena', 'aguarda', 'media')`).run(ana.serviceId);
    db.prepare(`INSERT INTO work_orders (service_id, title, status, priority) VALUES (NULL, 'Torre norte', 'agendada', 'alta')`).run();
    db.prepare(`INSERT INTO work_orders (service_id, title, status, priority) VALUES (?, 'Feita', 'concluida', 'alta')`).run(ana.serviceId);

    const { work } = await snapshot();
    expect(work.orders.map((o) => o.title)).toEqual(['Torre norte', 'Trocar antena']);
    expect(work.orders[0].clientName).toBeNull();
    expect(work.orders[1]).toMatchObject({ clientName: 'Ana', phone: '+2389912233', address: 'Rua 1', zone: 'Monte Sossego' });
  });
});

describe('loadClients — clientes no bolso', () => {
  test('everyone but the cancelled, by name, with plan, overdue debt and last payment', async () => {
    const plan = db.prepare(`INSERT INTO internet_plans (name) VALUES ('Fibra 50')`).run().lastInsertRowid as number;
    const bia = client('bia', '991 22 33', { zone: 'Monte' });
    db.prepare(`UPDATE services SET plan_id = ? WHERE id = ?`).run(plan, bia.serviceId);
    const paid = invoice(bia, 2500, 40);
    receipt(paid, 2500, '2026-10-05', null);
    invoice(bia, 2500, 10);
    invoice(bia, 9999, -5); // ainda não venceu: não é dívida
    client('Álvaro', null);
    const gone = client('Zeca', '9911111');
    db.prepare(`UPDATE clients SET status = 'cancelled' WHERE id = ?`).run(gone.clientId);

    const clients = (await snapshot()).clients;
    expect(clients.map((c) => c.name)).toEqual(['Álvaro', 'bia']);
    expect(clients[1]).toMatchObject({ phone: '+2389912233', plan: 'Fibra 50', zone: 'Monte', overdueCve: 2500, lastPaymentAt: '2026-10-05', status: 'active' });
    expect(clients[0]).toMatchObject({ phone: null, plan: null, overdueCve: 0, lastPaymentAt: null });
  });

  test('stops before the byte budget instead of overflowing the phone', () => {
    for (let i = 0; i < 30; i++) client(`Cliente ${String(i).padStart(2, '0')}`, `99100${String(i).padStart(2, '0')}`);
    const all = mod.loadClients(db);
    const tenBytes = 2 + all.slice(0, 10).reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)) + 1, 0);
    expect(mod.loadClients(db, tenBytes).map((c) => c.name)).toEqual(all.slice(0, 10).map((c) => c.name));
    expect(all.length).toBe(30);
  });
});
