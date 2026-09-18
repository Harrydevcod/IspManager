/**
 * Tesouraria: cada escudo tem de estar numa conta, e a soma dos saldos tem de
 * bater com aberturas + entradas − saídas. Quase todos os testes acabam por
 * verificar um saldo, porque é isso que o operador compara com a gaveta e com
 * o extrato do banco.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import BetterSqlite from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { migrations } from '../db/migrations';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let payments: typeof import('./payments');
let treasury: typeof import('./treasury');

const MONTH = '2026-07';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-treasury-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  payments = await import('./payments');
  treasury = await import('./treasury');
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

let cashId: number;
let bankId: number;

beforeEach(() => {
  db.exec(`
    DELETE FROM treasury_movements;
    DELETE FROM client_credits;
    DELETE FROM payment_receipts;
    DELETE FROM payment_lines;
    DELETE FROM payments;
    DELETE FROM services;
    DELETE FROM expenses;
    DELETE FROM clients;
    UPDATE payment_receipts SET account_id = NULL;
    DELETE FROM treasury_accounts;
  `);
  // Contas limpas, com abertura antiga para os movimentos de julho contarem.
  cashId = db.prepare(`
    INSERT INTO treasury_accounts (kind, name, opening_date, is_default_cash) VALUES ('caixa', 'Caixa escritorio', '2026-01-01', 1)
  `).run().lastInsertRowid as number;
  bankId = db.prepare(`
    INSERT INTO treasury_accounts (kind, name, bank_name, account_number, opening_date, show_on_documents)
    VALUES ('banco', 'BCA', 'BCA', '0003 0000 1234', '2026-01-01', 1)
  `).run().lastInsertRowid as number;
});

function seedInvoice(code: string, amountCve = 50000): number {
  const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')`)
    .run(code, `Cliente ${code}`).lastInsertRowid as number;
  const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, ?, 10, 'active')`)
    .run(clientId, amountCve).lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, invoice_date)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(clientId, serviceId, MONTH, amountCve, `${MONTH}-10`, `FT-${code}`, `${MONTH}-01`).lastInsertRowid as number;
}

const balance = (id: number) => treasury.accountBalance(db, id);

describe('recebimentos', () => {
  test('numerario sem conta cai na caixa predefinida, com recibo ligado', () => {
    const paymentId = seedInvoice('A');
    const result = payments.payPayment(db, paymentId, { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.accountId).toBe(cashId);
    expect(result.value.receipt.accountName).toBe('Caixa escritorio');
    expect(balance(cashId)).toBe(50000);
    expect(balance(bankId)).toBe(0);
  });

  test('transferencia exige banco e recusa caixa', () => {
    const paymentId = seedInvoice('B');

    const semConta = payments.payPayment(db, paymentId, { paymentMethod: 'transferencia', paymentDate: `${MONTH}-15` });
    expect(semConta.ok).toBe(false);
    const naCaixa = payments.payPayment(db, paymentId, { paymentMethod: 'transferencia', paymentDate: `${MONTH}-15`, accountId: cashId });
    expect(naCaixa.ok).toBe(false);

    // Nada foi escrito pelas tentativas falhadas: sem recibo, sem numero gasto.
    expect(payments.listPaymentReceipts(db, paymentId)).toHaveLength(0);

    const certo = payments.payPayment(db, paymentId, { paymentMethod: 'transferencia', paymentDate: `${MONTH}-15`, accountId: bankId });
    expect(certo.ok).toBe(true);
    expect(balance(bankId)).toBe(50000);
  });

  test('numerario num banco e recusado: deposita-se depois', () => {
    const paymentId = seedInvoice('C');
    const result = payments.payPayment(db, paymentId, { paymentMethod: 'numerario', paymentDate: `${MONTH}-15`, accountId: bankId });
    expect(result.ok).toBe(false);
  });

  test('o excesso entra todo na conta, mesmo sendo credito do cliente', () => {
    const paymentId = seedInvoice('D', 50000);
    const result = payments.payPayment(db, paymentId, { paymentMethod: 'numerario', paymentDate: `${MONTH}-15`, amountCve: 60000 });

    expect(result.ok && result.value.creditAddedCve).toBe(10000);
    expect(balance(cashId)).toBe(60000);
  });

  test('abater credito nao gera movimento: o dinheiro ja tinha entrado', () => {
    const first = seedInvoice('E', 50000);
    payments.payPayment(db, first, { paymentMethod: 'numerario', paymentDate: `${MONTH}-15`, amountCve: 60000 });
    const second = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, invoice_date)
      SELECT client_id, service_id, '2026-08', 50000, '2026-08-10', 'pending', 'FT-E2', '2026-08-01' FROM payments WHERE id = ?
    `).run(first).lastInsertRowid as number;

    const receipt = payments.applyClientCreditToPayment(db, second);

    expect(receipt?.amountCve).toBe(10000);
    expect(receipt?.accountId).toBeNull();
    expect(balance(cashId)).toBe(60000);
  });

  test('anular o recibo estorna a entrada na mesma conta', () => {
    const paymentId = seedInvoice('F');
    const paid = payments.payPayment(db, paymentId, { paymentMethod: 'transferencia', paymentDate: `${MONTH}-15`, accountId: bankId, amountCve: 20000 });
    if (!paid.ok) throw new Error(paid.error);

    const voided = payments.voidReceipt(db, paid.value.receipt.id, 'Transferencia devolvida pelo banco');

    expect(voided.ok).toBe(true);
    expect(balance(bankId)).toBe(0);
    const kinds = treasury.listMovements(db, { accountId: bankId }).map((m) => m.kind);
    expect(kinds.sort()).toEqual(['estorno', 'recebimento']);
  });
});

describe('depositos e transferencias', () => {
  test('caixa → banco e um deposito e move os dois saldos', () => {
    payments.payPayment(db, seedInvoice('G'), { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });

    const result = treasury.createTransfer(db, { fromAccountId: cashId, toAccountId: bankId, amountCve: 30000, movementDate: `${MONTH}-16`, reference: 'Talao 889' });

    expect(result.ok && result.value.kind).toBe('deposito');
    expect(balance(cashId)).toBe(20000);
    expect(balance(bankId)).toBe(30000);
  });

  test('nao deixa a caixa ficar negativa sem autorizacao explicita', () => {
    const recusa = treasury.createTransfer(db, { fromAccountId: cashId, toAccountId: bankId, amountCve: 1000 });
    expect(recusa.ok).toBe(false);
    if (!recusa.ok) expect(recusa.status).toBe(409);

    const forcado = treasury.createTransfer(db, { fromAccountId: cashId, toAccountId: bankId, amountCve: 1000, allowNegative: true });
    expect(forcado.ok).toBe(true);
    expect(balance(cashId)).toBe(-1000);
  });

  test('estornar um lado de um deposito estorna os dois', () => {
    payments.payPayment(db, seedInvoice('H'), { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });
    treasury.createTransfer(db, { fromAccountId: cashId, toAccountId: bankId, amountCve: 50000, movementDate: `${MONTH}-16` });
    const bankSide = treasury.listMovements(db, { accountId: bankId, kind: 'deposito' })[0];

    const result = treasury.reverseMovement(db, bankSide.id, 'Talao lancado no banco errado');

    expect(result.ok).toBe(true);
    expect(balance(cashId)).toBe(50000);
    expect(balance(bankId)).toBe(0);
    expect(treasury.reverseMovement(db, bankSide.id, 'Segunda tentativa de estorno').ok).toBe(false);
  });

  test('recebimentos nao se estornam a mao: anula-se o recibo', () => {
    payments.payPayment(db, seedInvoice('I'), { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });
    const entrada = treasury.listMovements(db, { accountId: cashId })[0];
    expect(treasury.reverseMovement(db, entrada.id, 'Tentativa de atalho').ok).toBe(false);
  });
});

describe('contagem de caixa', () => {
  test('bater certo nao lanca nada', () => {
    payments.payPayment(db, seedInvoice('J'), { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });
    const result = treasury.recordCashCount(db, { accountId: cashId, countedCve: 50000 });
    expect(result.ok && result.value.movementId).toBeNull();
  });

  test('uma falta exige motivo e fica como ajuste', () => {
    payments.payPayment(db, seedInvoice('K'), { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });

    expect(treasury.recordCashCount(db, { accountId: cashId, countedCve: 49500 }).ok).toBe(false);
    const result = treasury.recordCashCount(db, { accountId: cashId, countedCve: 49500, reason: 'Troco dado a mais ao cliente K' });

    expect(result.ok && result.value.differenceCve).toBe(-500);
    expect(balance(cashId)).toBe(49500);
  });
});

describe('saidas de despesas', () => {
  const expense = (amountCve: number) => db.prepare(`
    INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month) VALUES ('energia', 'Electra', ?, '2026-07-20', '2026-07')
  `).run(amountCve).lastInsertRowid as number;

  const sync = (id: number, accountId: number | null, amountCve: number) => db.transaction(() => treasury.syncSourceMovement(db, {
    kind: 'despesa', sourceId: id, accountId, amountCve, movementDate: '2026-07-20', description: 'Despesa: Electra', reason: 'teste'
  }))();

  test('mudar o valor estorna a saida antiga e lanca a nova', () => {
    const id = expense(8000);
    sync(id, bankId, 8000);
    expect(balance(bankId)).toBe(-8000);

    sync(id, bankId, 8000); // nada mudou: nao duplica
    expect(treasury.listMovements(db, { accountId: bankId })).toHaveLength(1);

    sync(id, bankId, 9000);
    expect(balance(bankId)).toBe(-9000);
    expect(treasury.listMovements(db, { accountId: bankId }).map((m) => m.kind).sort()).toEqual(['despesa', 'despesa', 'estorno']);
  });

  test('mudar de conta devolve a uma e tira a outra; sem conta devolve tudo', () => {
    const id = expense(5000);
    sync(id, bankId, 5000);
    sync(id, cashId, 5000);
    expect(balance(bankId)).toBe(0);
    expect(balance(cashId)).toBe(-5000);

    sync(id, null, 5000);
    expect(balance(cashId)).toBe(0);
  });
});

describe('saldos', () => {
  test('saldo = abertura + entradas − saidas, ignorando o que e anterior a abertura', () => {
    payments.payPayment(db, seedInvoice('L'), { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });
    treasury.updateAccount(db, cashId, { openingBalanceCve: 12500, openingDate: `${MONTH}-20` });

    // O recebimento de dia 15 ja esta dentro da abertura de dia 20.
    expect(balance(cashId)).toBe(12500);

    const extrato = treasury.listMovements(db, { accountId: cashId });
    expect(extrato[0].balanceAfterCve).toBeUndefined();
  });

  test('saldo corrido no extrato da conta', () => {
    payments.payPayment(db, seedInvoice('M', 10000), { paymentMethod: 'numerario', paymentDate: `${MONTH}-15` });
    payments.payPayment(db, seedInvoice('N', 5000), { paymentMethod: 'numerario', paymentDate: `${MONTH}-16` });
    treasury.createTransfer(db, { fromAccountId: cashId, toAccountId: bankId, amountCve: 12000, movementDate: `${MONTH}-17` });

    const extrato = treasury.listMovements(db, { accountId: cashId });
    expect(extrato.map((m) => m.balanceAfterCve)).toEqual([3000, 15000, 10000]);
  });

  test('so uma caixa predefinida e bancos nao o podem ser', () => {
    const outra = treasury.createAccount(db, { kind: 'caixa', name: 'Caixa tecnico', isDefaultCash: true });
    expect(outra.ok).toBe(true);
    const defaults = treasury.listAccounts(db).filter((a) => a.isDefaultCash);
    expect(defaults.map((a) => a.name)).toEqual(['Caixa tecnico']);

    expect(treasury.createAccount(db, { kind: 'banco', name: 'Caixa BAI', isDefaultCash: true }).ok).toBe(false);
  });

  test('as faturas imprimem so os bancos marcados e ativos', () => {
    treasury.createAccount(db, { kind: 'banco', name: 'BAI interno', bankName: 'BAI', accountNumber: '999' });
    expect(treasury.documentBankAccounts(db).map((a) => a.accountNumber)).toEqual(['0003 0000 1234']);
  });

  test('na fatura manda o NIB; o numero de conta e a reserva de quem nao o tem', () => {
    expect(treasury.documentBankAccounts(db).map((a) => a.accountNumber)).toEqual(['0003 0000 1234']);

    const updated = treasury.updateAccount(db, bankId, { nib: '0003 0000 1234 5678 9012 3' });
    expect(updated.ok).toBe(true);
    expect(treasury.documentBankAccounts(db).map((a) => a.accountNumber)).toEqual(['0003 0000 1234 5678 9012 3']);
  });

  test('o numero de conta e o NIB sao campos independentes', () => {
    const created = treasury.createAccount(db, {
      kind: 'banco', name: 'BCN', bankName: 'BCN', accountNumber: '12345', nib: '0005 0000 9999 8888 7777 6'
    });
    expect(created.ok).toBe(true);
    const account = treasury.listAccounts(db).find((a) => a.name === 'BCN')!;
    expect(account.accountNumber).toBe('12345');
    expect(account.nib).toBe('0005 0000 9999 8888 7777 6');

    // Apagar um nao apaga o outro.
    treasury.updateAccount(db, account.id, { accountNumber: '' });
    const after = treasury.listAccounts(db).find((a) => a.name === 'BCN')!;
    expect(after.accountNumber).toBeNull();
    expect(after.nib).toBe('0005 0000 9999 8888 7777 6');
  });
});

describe('migracao 0058', () => {
  test('cria a caixa principal e passa as contas das configuracoes a contas bancarias', () => {
    const fresh = new BetterSqlite(':memory:');
    try {
      runMigrations(fresh, migrations.filter((m) => m.version < 58));
      fresh.prepare(`INSERT INTO app_settings (key, value) VALUES ('bankAccounts', ?)`).run(JSON.stringify([
        { bankName: 'BCA', accountName: 'ISP Lda', accountNumber: '0003.0000.1', reference: '' },
        { bankName: '', accountName: '', accountNumber: '777', reference: 'NIB' }
      ]));
      runMigrations(fresh);

      const rows = fresh.prepare(`
        SELECT kind, name, account_number AS accountNumber, holder_name AS holderName, is_default_cash AS isDefaultCash, show_on_documents AS showOnDocuments
        FROM treasury_accounts ORDER BY sort_order
      `).all();
      expect(rows).toEqual([
        { kind: 'caixa', name: 'Caixa principal', accountNumber: null, holderName: null, isDefaultCash: 1, showOnDocuments: 0 },
        { kind: 'banco', name: 'BCA', accountNumber: '0003.0000.1', holderName: 'ISP Lda', isDefaultCash: 0, showOnDocuments: 1 },
        { kind: 'banco', name: 'Conta bancaria 2', accountNumber: '777', holderName: null, isDefaultCash: 0, showOnDocuments: 1 }
      ]);
    } finally {
      fresh.close();
    }
  });
});

describe('migracao 0059', () => {
  test('o que sao 21 digitos passa a NIB; o resto fica no numero de conta', () => {
    const fresh = new BetterSqlite(':memory:');
    try {
      runMigrations(fresh, migrations.filter((m) => m.version < 59));
      fresh.prepare(`
        INSERT INTO treasury_accounts (kind, name, account_number, opening_date) VALUES
          ('banco', 'Com NIB', '0003 0000 1234 5678 9012 3', '2026-01-01'),
          ('banco', 'Numero curto', '0003.0000.1', '2026-01-01'),
          ('banco', 'Vinte e um mas nao so digitos', 'CV6400030000123456789', '2026-01-01')
      `).run();
      runMigrations(fresh);

      expect(fresh.prepare(`
        SELECT name, account_number AS accountNumber, nib FROM treasury_accounts WHERE kind = 'banco' ORDER BY id
      `).all()).toEqual([
        { name: 'Com NIB', accountNumber: null, nib: '0003 0000 1234 5678 9012 3' },
        { name: 'Numero curto', accountNumber: '0003.0000.1', nib: null },
        { name: 'Vinte e um mas nao so digitos', accountNumber: 'CV6400030000123456789', nib: null }
      ]);
    } finally {
      fresh.close();
    }
  });
});
