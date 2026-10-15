import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

let db: Database.Database;
let dir: string;
let close: () => void;
let sales: typeof import('./sale-tickets');
let payments: typeof import('./payments');
let treasury: typeof import('./treasury');
let accountId: number;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ispm-tv-'));
  process.env.ISPM_DATA_DIR = dir;
  const database = await import('../db/database');
  database.getDatabase(); db = database.getSqliteDatabase(); close = database.closeDatabaseForTests;
  sales = await import('./sale-tickets');
  payments = await import('./payments');
  treasury = await import('./treasury');
});
beforeEach(() => {
  db.exec('DELETE FROM stock_movements; DELETE FROM sale_ticket_serials; DELETE FROM sale_ticket_lines; DELETE FROM treasury_movements; DELETE FROM payment_receipts; DELETE FROM payment_lines; DELETE FROM articles; DELETE FROM payments; DELETE FROM equipment_catalog; DELETE FROM treasury_accounts;');
  const account = treasury.createAccount(db, { kind: 'caixa', name: 'TV caixa', openingDate: '2020-01-01' });
  if (!account.ok) throw new Error(account.error);
  accountId = account.value.id;
});
afterAll(() => { close?.(); rmSync(dir, { recursive: true, force: true }); delete process.env.ISPM_DATA_DIR; });

function input(overrides: Record<string, unknown> = {}) {
  return { requestKey: randomUUID(), paymentMethod: 'numerario', accountId,
    lines: [{ description: 'Deslocação', quantity: 1, unitPriceCve: 1250.25 }], ...overrides };
}
function emit(overrides: Record<string, unknown> = {}) { return sales.createSaleTicket(db, input(overrides), null); }
function mustEmit(overrides: Record<string, unknown> = {}) {
  const result = emit(overrides); if (!result.ok) throw new Error(result.error); return result.value;
}
function catalog(serialized = false, stock = 5) {
  return Number(db.prepare("INSERT INTO equipment_catalog(category,type,model,is_serialized,stock_total,selling_price_cve) VALUES ('equipamento','router','Modelo',?,?,1000)").run(serialized ? 1 : 0, stock).lastInsertRowid);
}

test('emite TV sem NIF, sem serviço, integralmente recebido uma única vez', () => {
  const ticket = mustEmit();
  expect(ticket.documentNumber).toMatch(/^TV-\d{4}-\d{5}$/);
  expect(sales.loadSaleTicket(db, ticket.paymentId)).toMatchObject({ status: 'paid', amountCve: 1250.25, clientName: 'Cliente Indiferenciado' });
  expect(db.prepare('SELECT service_id, document_type FROM payments WHERE id=?').get(ticket.paymentId)).toEqual({ service_id: null, document_type: 'sale_ticket' });
  expect(treasury.accountBalance(db, accountId)).toBe(1250.25);
  expect(db.prepare('SELECT count(*) AS n FROM payment_receipts').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT count(*) AS n FROM client_credits').get()).toEqual({ n: 0 });
});
test('venda mista conserva descrição/preço e retira stock', () => {
  const catalogId = catalog();
  const ticket = mustEmit({ lines: [{ description: 'Visita', quantity: 1, unitPriceCve: 500 }, { catalogId, quantity: 2, unitPriceCve: 900 }] });
  db.prepare("UPDATE equipment_catalog SET model='Novo', selling_price_cve=2000 WHERE id=?").run(catalogId);
  expect(sales.loadSaleTicket(db, ticket.paymentId)?.lines).toMatchObject([{ description: 'Visita', totalCve: 500 }, { description: 'Modelo', quantity: 2, unitPriceCve: 900, totalCve: 1800 }]);
  expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id=?').get(catalogId)).toEqual({ n: 3 });
  expect(treasury.accountBalance(db, accountId)).toBe(2300);
});
test('mesma chave recupera venda mesmo após mudança do catálogo; corpo diferente recusa', () => {
  const requestKey = randomUUID(); const catalogId = catalog();
  const body = { requestKey, lines: [{ catalogId, quantity: 1, unitPriceCve: 700 }] };
  const first = mustEmit(body);
  db.prepare('UPDATE equipment_catalog SET active=0 WHERE id=?').run(catalogId);
  expect(emit(body)).toMatchObject({ ok: true, value: first });
  expect(emit({ ...body, lines: [{ catalogId, quantity: 2, unitPriceCve: 700 }] })).toMatchObject({ ok: false, status: 409 });
  expect(treasury.accountBalance(db, accountId)).toBe(700);
});
test('valida stock agregado e não deixa documento ou dinheiro parcial', () => {
  const catalogId = catalog(false, 1);
  expect(emit({ lines: [{ catalogId, quantity: 1, unitPriceCve: 500 }, { catalogId, quantity: 1, unitPriceCve: 500 }] })).toMatchObject({ ok: false, status: 409 });
  expect(db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 0 });
  expect(treasury.accountBalance(db, accountId)).toBe(0);
});
test('última unidade só pode ser vendida uma vez', () => {
  const catalogId = catalog(false, 1); const lines = [{ catalogId, quantity: 1, unitPriceCve: 100 }];
  expect(emit({ lines })).toMatchObject({ ok: true });
  expect(emit({ lines })).toMatchObject({ ok: false, status: 409 });
  expect(treasury.accountBalance(db, accountId)).toBe(100);
});

test.each([false, true])('duas conexões concorrentes disputam stock ou repetem a mesma emissão: mesma chave=%s', async (sameRequest) => {
  const catalogId = catalog(false, 1);
  const bootstrap = createRequire(path.resolve('package.json')).resolve('tsx/cjs');
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    require(workerData.bootstrap);
    const Database = require('better-sqlite3');
    const { createSaleTicket } = require(workerData.module);
    const db = new Database(workerData.file);
    db.pragma('foreign_keys = ON');
    parentPort.once('message', () => {
      try { parentPort.postMessage({ result: createSaleTicket(db, workerData.input, null) }); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { db.close(); }
    });
    parentPort.postMessage({ ready: true });
  `;
  const sharedInput = input({ lines: [{ catalogId, quantity: 1, unitPriceCve: 100 }] });
  const workers = [0, 1].map(() => new Worker(script, { eval: true, workerData: {
    bootstrap, module: path.resolve('src/backend/lib/sale-tickets.ts'), file: db.name,
    input: sameRequest ? sharedInput : input({ lines: [{ catalogId, quantity: 1, unitPriceCve: 100 }] })
  } }));
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once('error', reject); worker.once('message', (message) => message.ready ? resolve() : reject(new Error('Worker not ready')));
    })));
    const completed = workers.map((worker) => new Promise<{ result?: { ok: boolean; status?: number }; error?: string }>((resolve, reject) => {
      worker.once('error', reject); worker.once('message', resolve);
    }));
    workers.forEach((worker) => worker.postMessage('emit'));
    const results = await Promise.all(completed);
    expect(results.filter((result) => result.error)).toEqual([]);
    expect(results.filter((result) => result.result?.ok)).toHaveLength(sameRequest ? 2 : 1);
    expect(results.filter((result) => result.result?.status === 409)).toHaveLength(sameRequest ? 0 : 1);
    expect(db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM payment_receipts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM stock_movements').get()).toEqual({ n: 1 });
    expect(treasury.accountBalance(db, accountId)).toBe(100);
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
}, 20000);
test.each([{ serialNumbers: [] }, { serialNumbers: ['s1', 'S1'] }])('serializado exige um serial distinto por unidade: %j', ({ serialNumbers }) => {
  const catalogId = catalog(true);
  expect(emit({ lines: [{ catalogId, quantity: 2, unitPriceCve: 100, serialNumbers }] })).toMatchObject({ ok: false });
  expect(db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 0 });
});
test('serial vendido não pode ser vendido novamente; anulação liberta e repõe só uma vez', () => {
  const catalogId = catalog(true); const lines = [{ catalogId, quantity: 1, unitPriceCve: 100, serialNumbers: [' Ser-01 '] }];
  const first = mustEmit({ lines });
  expect(emit({ lines })).toMatchObject({ ok: false, status: 409 });
  expect(sales.cancelSaleTicket(db, first.paymentId, 'Venda emitida por engano', true, null)).toMatchObject({ ok: true });
  expect(sales.cancelSaleTicket(db, first.paymentId, 'Venda emitida por engano', true, null)).toMatchObject({ ok: true });
  expect(treasury.accountBalance(db, accountId)).toBe(0);
  expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id=?').get(catalogId)).toEqual({ n: 5 });
  expect(emit({ lines })).toMatchObject({ ok: true });
});
test('anulação exige motivo e confirmação de devolução', () => {
  const ticket = mustEmit();
  expect(sales.cancelSaleTicket(db, ticket.paymentId, 'curto', true, null)).toMatchObject({ ok: false, status: 400 });
  expect(sales.cancelSaleTicket(db, ticket.paymentId, 'Motivo suficientemente longo', false, null)).toMatchObject({ ok: false, status: 400 });
  expect(treasury.accountBalance(db, accountId)).toBe(1250.25);
});
test('recebimento TV bloqueia portas genéricas', () => {
  const ticket = mustEmit(); const receipt = payments.listPaymentReceipts(db, ticket.paymentId)[0];
  expect(payments.voidReceipt(db, receipt.id, 'Tentativa fora do fluxo TV')).toMatchObject({ ok: false, status: 409 });
  expect(payments.cancelPayment(db, ticket.paymentId, 'Tentativa fora do fluxo TV')).toMatchObject({ ok: false, status: 409 });
  expect(payments.payPayment(db, ticket.paymentId, { paymentMethod: 'numerario' })).toMatchObject({ ok: false, status: 409 });
  expect(payments.applyClientCreditToPayment(db, ticket.paymentId, null)).toBeNull();
});
test.each([NaN, Infinity, 0, -1, 1e20])('recusa valor inválido %s antes de emitir', (unitPriceCve) => {
  expect(emit({ lines: [{ description: 'Valor', quantity: 1, unitPriceCve }] })).toMatchObject({ ok: false, status: 400 });
});
test('conta inválida não retira stock nem consome numeração', () => {
  const catalogId = catalog();
  const before = db.prepare('SELECT * FROM document_sequences').all();
  expect(emit({ accountId: 999999, lines: [{ catalogId, quantity: 1, unitPriceCve: 100 }] })).toMatchObject({ ok: false });
  expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id=?').get(catalogId)).toEqual({ n: 5 });
  expect(db.prepare('SELECT * FROM document_sequences').all()).toEqual(before);
});

test('venda não pode anteceder a abertura da conta de destino', () => {
  db.prepare("UPDATE treasury_accounts SET opening_date='2026-10-01' WHERE id=?").run(accountId);
  const before = db.prepare('SELECT * FROM document_sequences').all();
  expect(emit({ issuedOn: '2026-09-30' })).toMatchObject({ ok: false, status: 400 });
  expect(db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT * FROM document_sequences').all()).toEqual(before);
  expect(treasury.accountBalance(db, accountId)).toBe(0);
});

test.each(['invoicePrefix', 'receiptPrefix'])('recusa configuração antiga que use o prefixo TV reservado: %s', (key) => {
  db.prepare('INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)').run(key, 'TV');
  try {
    expect(emit()).toMatchObject({ ok: false, status: 409 });
    expect(db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 0 });
  } finally { db.prepare('DELETE FROM app_settings WHERE key=?').run(key); }
});

test('TV retroativo utiliza a série do ano de emissão', () => {
  const sale = mustEmit({ issuedOn: '2025-12-31' });
  expect(sale.documentNumber).toMatch(/^TV-2025-\d{5}$/);
});

test('documento, recebimento e sequências usam a conexão fornecida', async () => {
  const other = new Database(':memory:');
  try {
    const { runMigrations } = await import('../db/migrate'); runMigrations(other);
    const account = treasury.createAccount(other, { kind: 'caixa', name: 'Caixa isolada', openingDate: '2020-01-01' });
    if (!account.ok) throw new Error(account.error);
    const before = db.prepare('SELECT * FROM document_sequences').all();
    expect(sales.createSaleTicket(other, input({ accountId: account.value.id }), null)).toMatchObject({ ok: true });
    expect(other.prepare("SELECT last_number FROM document_sequences WHERE series='TV'").get()).toEqual({ last_number: 1 });
    expect(other.prepare("SELECT last_number FROM document_sequences WHERE series='RC'").get()).toEqual({ last_number: 1 });
    expect(db.prepare('SELECT * FROM document_sequences').all()).toEqual(before);
  } finally { other.close(); }
});

test('falha de tesouraria reverte stock, seriais, documento, recibo e sequência', () => {
  const catalogId = catalog(true); const before = db.prepare('SELECT * FROM document_sequences').all();
  db.exec("CREATE TEMP TRIGGER fail_tv_receipt BEFORE INSERT ON treasury_movements BEGIN SELECT RAISE(ABORT,'forced treasury failure'); END");
  try {
    expect(() => emit({ lines: [{ catalogId, quantity: 1, unitPriceCve: 100, serialNumbers: ['ROLLBACK'] }] })).toThrow('forced treasury failure');
    for (const table of ['payments', 'payment_receipts', 'sale_ticket_serials', 'stock_movements']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id=?').get(catalogId)).toEqual({ n: 5 });
    expect(db.prepare('SELECT * FROM document_sequences').all()).toEqual(before);
  } finally { db.exec('DROP TRIGGER fail_tv_receipt'); }
});

test('falha de reposição na anulação reverte o estorno e conserva a venda e serial', () => {
  const catalogId = catalog(true); const sale = mustEmit({ lines: [{ catalogId, quantity: 1, unitPriceCve: 100, serialNumbers: ['KEEP-SOLD'] }] });
  db.exec("CREATE TEMP TRIGGER fail_tv_return BEFORE INSERT ON stock_movements WHEN NEW.type='devolucao' BEGIN SELECT RAISE(ABORT,'forced stock failure'); END");
  try {
    expect(() => sales.cancelSaleTicket(db, sale.paymentId, 'Anulação com falha simulada', true, null)).toThrow('forced stock failure');
    expect(treasury.accountBalance(db, accountId)).toBe(100);
    expect(sales.loadSaleTicket(db, sale.paymentId)?.status).toBe('paid');
    expect(db.prepare('SELECT released_at FROM sale_ticket_serials').get()).toEqual({ released_at: null });
    expect(db.prepare('SELECT voided_at FROM payment_receipts').get()).toEqual({ voided_at: null });
    expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id=?').get(catalogId)).toEqual({ n: 4 });
  } finally { db.exec('DROP TRIGGER fail_tv_return'); }
});

test('linha livre cria um artigo com código e a mesma descrição reutiliza-o', () => {
  mustEmit({ lines: [{ description: 'Cabo  RJ45', quantity: 1, unitPriceCve: 150 }] });
  mustEmit({ lines: [{ description: 'cabo rj45', quantity: 2, unitPriceCve: 150 }] });
  expect(db.prepare('SELECT code,name,kind,unit_price_centavos AS price FROM articles').all()).toEqual([{ code: 'ART0001', name: 'Cabo RJ45', kind: 'product', price: 15000 }]);
  expect(db.prepare('SELECT DISTINCT article_id AS id FROM payment_lines').all()).toEqual([{ id: expect.any(Number) }]);
});
test('linha de artigo escolhido usa o nome dele; produto do stock não cria artigo', () => {
  const articleId = Number(db.prepare("INSERT INTO articles(code,name,kind) VALUES ('SRV0009','Configuração','service')").run().lastInsertRowid);
  const catalogId = catalog();
  const ticket = mustEmit({ lines: [{ articleId, quantity: 1, unitPriceCve: 300 }, { catalogId, quantity: 1, unitPriceCve: 900 }] });
  expect(db.prepare('SELECT description,article_id AS articleId FROM payment_lines WHERE payment_id=? ORDER BY sort_order').all(ticket.paymentId))
    .toEqual([{ description: 'Configuração', articleId }, { description: 'Modelo', articleId: null }]);
  db.prepare('UPDATE articles SET active=0 WHERE id=?').run(articleId);
  expect(emit({ lines: [{ articleId, quantity: 1, unitPriceCve: 300 }] })).toMatchObject({ ok: false, status: 409 });
});

test('cada prefixo conta à parte: o primeiro serviço é SRV0001 mesmo depois de um produto', async () => {
  mustEmit({ lines: [{ description: 'Conector', quantity: 1, unitPriceCve: 50 }] });
  const { resolveFreeLineArticle } = await import('./articles');
  resolveFreeLineArticle(db, 'Instalação', 1000, 'service');
  expect(db.prepare('SELECT code FROM articles ORDER BY id').all()).toEqual([{ code: 'ART0001' }, { code: 'SRV0001' }]);
});
