import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { escudosToCentavos, roundEscudos } from '../../shared/money';
import { todayIso } from './billing';

/**
 * Tesouraria: onde está o dinheiro (0058).
 *
 * Fonte única das regras de caixas e bancos. `payments.ts`, as despesas e os
 * investimentos chamam daqui para o dinheiro que entra e sai; nenhum módulo
 * escreve em `treasury_movements` por conta própria.
 *
 * O livro-razão é só de acrescento. Corrigir é estornar: um movimento de sinal
 * contrário, com motivo, ligado ao original por `reversal_of_id`.
 */

export type TreasuryAccountKind = 'caixa' | 'banco';
export type MovementDirection = 'in' | 'out';
export type MovementKind =
  | 'recebimento' | 'deposito' | 'transferencia' | 'despesa' | 'investimento' | 'ajuste' | 'estorno';
export type ReceiptPaymentMethod = 'numerario' | 'transferencia' | 'outro';

export type TreasuryResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

export type TreasuryAccount = {
  id: number;
  kind: TreasuryAccountKind;
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  holderName: string | null;
  reference: string | null;
  openingBalanceCve: number;
  openingDate: string;
  isDefaultCash: boolean;
  showOnDocuments: boolean;
  active: boolean;
  sortOrder: number;
  balanceCve: number;
  lastMovementDate: string | null;
};

export type TreasuryMovement = {
  id: number;
  accountId: number;
  accountName: string;
  accountKind: TreasuryAccountKind;
  direction: MovementDirection;
  amountCve: number;
  movementDate: string;
  kind: MovementKind;
  receiptId: number | null;
  expenseId: number | null;
  investmentId: number | null;
  transferGroup: string | null;
  reversalOfId: number | null;
  reversedById: number | null;
  reference: string | null;
  description: string;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  /** Só quando a listagem é de uma conta: o saldo depois deste movimento. */
  balanceAfterCve?: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Saldo em SQL: abertura + entradas − saídas desde a data de abertura. */
function balanceSql(alias: string): string {
  return `ROUND(${alias}.opening_balance_cve + COALESCE((
    SELECT SUM(CASE WHEN m.direction = 'in' THEN m.amount_cve ELSE -m.amount_cve END)
    FROM treasury_movements m
    WHERE m.account_id = ${alias}.id AND m.movement_date >= ${alias}.opening_date
  ), 0), 2)`;
}

const accountSelect = `
  SELECT a.id, a.kind, a.name, a.bank_name AS bankName, a.account_number AS accountNumber,
         a.holder_name AS holderName, a.reference, a.opening_balance_cve AS openingBalanceCve,
         a.opening_date AS openingDate, a.is_default_cash AS isDefaultCash,
         a.show_on_documents AS showOnDocuments, a.active, a.sort_order AS sortOrder,
         ${balanceSql('a')} AS balanceCve,
         (SELECT MAX(m.movement_date) FROM treasury_movements m WHERE m.account_id = a.id) AS lastMovementDate
  FROM treasury_accounts a
`;

type AccountRow = Omit<TreasuryAccount, 'isDefaultCash' | 'showOnDocuments' | 'active'> & {
  isDefaultCash: number; showOnDocuments: number; active: number;
};

function toAccount(row: AccountRow): TreasuryAccount {
  return {
    ...row,
    balanceCve: roundEscudos(row.balanceCve),
    isDefaultCash: row.isDefaultCash === 1,
    showOnDocuments: row.showOnDocuments === 1,
    active: row.active === 1
  };
}

export function listAccounts(db: Database, { includeInactive = true } = {}): TreasuryAccount[] {
  const where = includeInactive ? '' : 'WHERE a.active = 1';
  const rows = db.prepare(`${accountSelect} ${where} ORDER BY a.active DESC, a.kind, a.sort_order, a.name`).all() as AccountRow[];
  return rows.map(toAccount);
}

export function getAccount(db: Database, id: number): TreasuryAccount | undefined {
  const row = db.prepare(`${accountSelect} WHERE a.id = ?`).get(id) as AccountRow | undefined;
  return row ? toAccount(row) : undefined;
}

export function accountBalance(db: Database, id: number): number {
  return getAccount(db, id)?.balanceCve ?? 0;
}

// ---------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------

export type AccountInput = {
  kind: TreasuryAccountKind;
  name: string;
  bankName?: string | null;
  accountNumber?: string | null;
  holderName?: string | null;
  reference?: string | null;
  openingBalanceCve?: number;
  openingDate?: string;
  isDefaultCash?: boolean;
  showOnDocuments?: boolean;
  active?: boolean;
};

const clean = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

function validateAccount(input: AccountInput): string | null {
  if (!input.name?.trim()) return 'A conta precisa de um nome.';
  if (input.openingDate !== undefined && !ISO_DATE.test(input.openingDate)) return 'Data de abertura invalida.';
  if (input.openingBalanceCve !== undefined && !Number.isFinite(input.openingBalanceCve)) return 'Saldo de abertura invalido.';
  if (input.kind === 'caixa' && input.showOnDocuments) return 'Uma caixa nao sai nas faturas: so contas bancarias.';
  if (input.kind === 'banco' && input.isDefaultCash) return 'So uma caixa pode ser a predefinida para numerario.';
  if (input.isDefaultCash && input.active === false) return 'A caixa predefinida nao pode ser desativada.';
  return null;
}

export function createAccount(db: Database, input: AccountInput, userId?: number | null): TreasuryResult<TreasuryAccount> {
  const error = validateAccount(input);
  if (error) return fail(400, error);

  const id = db.transaction(() => {
    if (input.isDefaultCash) db.prepare('UPDATE treasury_accounts SET is_default_cash = 0 WHERE is_default_cash = 1').run();
    const info = db.prepare(`
      INSERT INTO treasury_accounts (
        kind, name, bank_name, account_number, holder_name, reference,
        opening_balance_cve, opening_date, is_default_cash, show_on_documents, active, sort_order, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM treasury_accounts), ?)
    `).run(
      input.kind,
      input.name.trim(),
      input.kind === 'banco' ? clean(input.bankName) : null,
      input.kind === 'banco' ? clean(input.accountNumber) : null,
      input.kind === 'banco' ? clean(input.holderName) : null,
      input.kind === 'banco' ? clean(input.reference) : null,
      roundEscudos(input.openingBalanceCve ?? 0),
      input.openingDate ?? todayIso(),
      input.isDefaultCash ? 1 : 0,
      input.showOnDocuments ? 1 : 0,
      input.active === false ? 0 : 1,
      userId ?? null
    );
    return Number(info.lastInsertRowid);
  })();

  return { ok: true, value: getAccount(db, id)! };
}

export function updateAccount(
  db: Database,
  id: number,
  patch: Partial<Omit<AccountInput, 'kind'>>
): TreasuryResult<TreasuryAccount> {
  const current = getAccount(db, id);
  if (!current) return fail(404, 'Conta nao encontrada');

  const merged: AccountInput = {
    kind: current.kind,
    name: patch.name ?? current.name,
    bankName: patch.bankName !== undefined ? patch.bankName : current.bankName,
    accountNumber: patch.accountNumber !== undefined ? patch.accountNumber : current.accountNumber,
    holderName: patch.holderName !== undefined ? patch.holderName : current.holderName,
    reference: patch.reference !== undefined ? patch.reference : current.reference,
    openingBalanceCve: patch.openingBalanceCve ?? current.openingBalanceCve,
    openingDate: patch.openingDate ?? current.openingDate,
    isDefaultCash: patch.isDefaultCash ?? current.isDefaultCash,
    showOnDocuments: patch.showOnDocuments ?? current.showOnDocuments,
    active: patch.active ?? current.active
  };
  const error = validateAccount(merged);
  if (error) return fail(400, error);
  if (current.isDefaultCash && patch.isDefaultCash === false) {
    return fail(400, 'Para mudar a caixa predefinida, marque outra caixa como predefinida.');
  }

  db.transaction(() => {
    if (merged.isDefaultCash && !current.isDefaultCash) {
      db.prepare('UPDATE treasury_accounts SET is_default_cash = 0 WHERE is_default_cash = 1').run();
    }
    db.prepare(`
      UPDATE treasury_accounts
      SET name = ?, bank_name = ?, account_number = ?, holder_name = ?, reference = ?,
          opening_balance_cve = ?, opening_date = ?, is_default_cash = ?, show_on_documents = ?,
          active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      merged.name.trim(),
      clean(merged.bankName),
      clean(merged.accountNumber),
      clean(merged.holderName),
      clean(merged.reference),
      roundEscudos(merged.openingBalanceCve ?? 0),
      merged.openingDate,
      merged.isDefaultCash ? 1 : 0,
      merged.showOnDocuments ? 1 : 0,
      merged.active ? 1 : 0,
      id
    );
  })();

  return { ok: true, value: getAccount(db, id)! };
}

/** Contas bancárias que saem nas faturas, pela ordem da tesouraria. */
export function documentBankAccounts(db: Database) {
  return db.prepare(`
    SELECT COALESCE(bank_name, name) AS bankName, COALESCE(holder_name, '') AS accountName,
           COALESCE(account_number, '') AS accountNumber, COALESCE(reference, '') AS reference
    FROM treasury_accounts
    WHERE kind = 'banco' AND active = 1 AND show_on_documents = 1
    ORDER BY sort_order, id
  `).all() as Array<{ bankName: string; accountName: string; accountNumber: string; reference: string }>;
}

// ---------------------------------------------------------------------------
// Movimentos
// ---------------------------------------------------------------------------

type MovementInsert = {
  accountId: number;
  direction: MovementDirection;
  amountCve: number;
  movementDate: string;
  kind: MovementKind;
  description: string;
  receiptId?: number | null;
  expenseId?: number | null;
  investmentId?: number | null;
  transferGroup?: string | null;
  reversalOfId?: number | null;
  reference?: string | null;
  userId?: number | null;
};

function insertMovement(db: Database, m: MovementInsert): number {
  const info = db.prepare(`
    INSERT INTO treasury_movements (
      account_id, direction, amount_cve, movement_date, kind, receipt_id, expense_id,
      investment_id, transfer_group, reversal_of_id, reference, description, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.accountId,
    m.direction,
    roundEscudos(m.amountCve),
    m.movementDate,
    m.kind,
    m.receiptId ?? null,
    m.expenseId ?? null,
    m.investmentId ?? null,
    m.transferGroup ?? null,
    m.reversalOfId ?? null,
    clean(m.reference),
    m.description,
    m.userId ?? null
  );
  return Number(info.lastInsertRowid);
}

const movementSelect = `
  SELECT m.id, m.account_id AS accountId, a.name AS accountName, a.kind AS accountKind,
         m.direction, m.amount_cve AS amountCve, m.movement_date AS movementDate, m.kind,
         m.receipt_id AS receiptId, m.expense_id AS expenseId, m.investment_id AS investmentId,
         m.transfer_group AS transferGroup, m.reversal_of_id AS reversalOfId,
         (SELECT r.id FROM treasury_movements r WHERE r.reversal_of_id = m.id) AS reversedById,
         m.reference, m.description, m.created_by AS createdBy, u.full_name AS createdByName,
         m.created_at AS createdAt
  FROM treasury_movements m
  JOIN treasury_accounts a ON a.id = m.account_id
  LEFT JOIN users u ON u.id = m.created_by
`;

export type MovementFilters = { accountId?: number; from?: string; to?: string; kind?: MovementKind };

export function listMovements(db: Database, filters: MovementFilters = {}): TreasuryMovement[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.accountId) { where.push('m.account_id = ?'); params.push(filters.accountId); }
  if (filters.from) { where.push('m.movement_date >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('m.movement_date <= ?'); params.push(filters.to); }
  if (filters.kind) { where.push('m.kind = ?'); params.push(filters.kind); }
  const sql = `${movementSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.movement_date, m.id`;
  const rows = db.prepare(sql).all(...params) as TreasuryMovement[];

  if (filters.accountId) {
    // Saldo corrido a partir do saldo da conta no início do período pedido.
    const account = getAccount(db, filters.accountId);
    if (account) {
      const before = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cve ELSE -amount_cve END), 0) AS total
        FROM treasury_movements
        WHERE account_id = ? AND movement_date >= ? AND movement_date < ?
      `).get(account.id, account.openingDate, filters.from ?? account.openingDate) as { total: number };
      let running = escudosToCentavos(account.openingBalanceCve + before.total);
      for (const row of rows) {
        if (row.movementDate < account.openingDate) continue;
        running += (row.direction === 'in' ? 1 : -1) * escudosToCentavos(row.amountCve);
        row.balanceAfterCve = running / 100;
      }
    }
  }

  return rows.reverse();
}

function loadMovement(db: Database, id: number): TreasuryMovement | undefined {
  return db.prepare(`${movementSelect} WHERE m.id = ?`).get(id) as TreasuryMovement | undefined;
}

function validAmount(amount: number): number | null {
  const rounded = roundEscudos(amount);
  return Number.isFinite(rounded) && escudosToCentavos(rounded) > 0 ? rounded : null;
}

// ---------------------------------------------------------------------------
// Recebimentos
// ---------------------------------------------------------------------------

/**
 * Para onde vai um recebimento, pelo método de pagamento.
 *
 * Numerário cai numa caixa (a escolhida, ou a predefinida). Transferência só
 * pode cair num banco, e alguém tem de dizer qual: adivinhar deixava o saldo de
 * dois bancos errado ao mesmo tempo. "Outro" (Vinti4, cheque…) pede a conta.
 */
export function resolveReceiptAccount(
  db: Database,
  method: ReceiptPaymentMethod,
  accountId?: number | null
): TreasuryResult<TreasuryAccount> {
  if (accountId) {
    const account = getAccount(db, accountId);
    if (!account || !account.active) return fail(400, 'Conta de destino inexistente ou desativada.');
    if (method === 'numerario' && account.kind !== 'caixa') {
      return fail(400, 'Numerario entra numa caixa. Para um banco, registe como transferencia ou deposite depois.');
    }
    if (method === 'transferencia' && account.kind !== 'banco') {
      return fail(400, 'Uma transferencia entra numa conta bancaria, nao numa caixa.');
    }
    return { ok: true, value: account };
  }

  if (method === 'numerario') {
    const row = db.prepare('SELECT id FROM treasury_accounts WHERE is_default_cash = 1 AND active = 1').get() as { id: number } | undefined;
    if (!row) return fail(400, 'Nao ha caixa predefinida ativa. Escolha a caixa ou defina uma na Tesouraria.');
    return { ok: true, value: getAccount(db, row.id)! };
  }
  return fail(400, method === 'transferencia'
    ? 'Indique o banco onde a transferencia foi recebida.'
    : 'Indique a conta onde o dinheiro foi recebido.');
}

/** Chamada de dentro da transação do recibo. */
export function recordReceiptMovement(db: Database, input: {
  receiptId: number;
  accountId: number;
  amountCve: number;
  movementDate: string;
  description: string;
  userId?: number | null;
}): number {
  db.prepare('UPDATE payment_receipts SET account_id = ? WHERE id = ?').run(input.accountId, input.receiptId);
  return insertMovement(db, {
    accountId: input.accountId,
    direction: 'in',
    amountCve: input.amountCve,
    movementDate: input.movementDate,
    kind: 'recebimento',
    receiptId: input.receiptId,
    description: input.description,
    userId: input.userId
  });
}

function reverseInTransaction(db: Database, original: TreasuryMovement, reason: string, date: string, userId?: number | null): number {
  return insertMovement(db, {
    accountId: original.accountId,
    direction: original.direction === 'in' ? 'out' : 'in',
    amountCve: original.amountCve,
    movementDate: date,
    kind: 'estorno',
    receiptId: original.receiptId,
    expenseId: original.expenseId,
    investmentId: original.investmentId,
    transferGroup: original.transferGroup,
    reversalOfId: original.id,
    description: `Estorno: ${original.description} — ${reason}`,
    userId
  });
}

/** Movimentos ainda válidos (nem estornos nem estornados) ligados a uma origem. */
function activeMovementsFor(db: Database, column: 'receipt_id' | 'expense_id' | 'investment_id', id: number, kind: MovementKind) {
  return db.prepare(`
    ${movementSelect}
    WHERE m.${column} = ? AND m.kind = ?
      AND NOT EXISTS (SELECT 1 FROM treasury_movements r WHERE r.reversal_of_id = m.id)
  `).all(id, kind) as TreasuryMovement[];
}

/** Anular um recibo tira o dinheiro da conta onde tinha entrado. Dentro da transação. */
export function reverseReceiptMovements(db: Database, receiptId: number, reason: string, userId?: number | null): number {
  const open = activeMovementsFor(db, 'receipt_id', receiptId, 'recebimento');
  for (const movement of open) reverseInTransaction(db, movement, reason, todayIso(), userId);
  return open.length;
}

// ---------------------------------------------------------------------------
// Saídas de despesas e investimentos
// ---------------------------------------------------------------------------

/**
 * Acerta a saída de uma despesa ou investimento com o que está gravado.
 *
 * Se a conta, o valor ou a data mudaram, estorna a saída antiga e lança a
 * nova; se nada mudou, não mexe. `accountId = null` (ou valor zero) estorna e
 * não lança — a despesa deixa de estar paga por uma conta. Dentro da transação.
 */
export function syncSourceMovement(db: Database, input: {
  kind: 'despesa' | 'investimento';
  sourceId: number;
  accountId: number | null;
  amountCve: number;
  movementDate: string;
  description: string;
  reason: string;
  userId?: number | null;
}): void {
  const column = input.kind === 'despesa' ? 'expense_id' : 'investment_id';
  const open = activeMovementsFor(db, column, input.sourceId, input.kind);
  const amount = validAmount(input.amountCve);
  const unchanged = open.length === 1 && input.accountId !== null && amount !== null
    && open[0].accountId === input.accountId
    && escudosToCentavos(open[0].amountCve) === escudosToCentavos(amount)
    && open[0].movementDate === input.movementDate;
  if (unchanged) {
    if (open[0].description !== input.description) {
      db.prepare('UPDATE treasury_movements SET description = ? WHERE id = ?').run(input.description, open[0].id);
    }
    return;
  }

  for (const movement of open) reverseInTransaction(db, movement, input.reason, todayIso(), input.userId);
  if (input.accountId === null || amount === null) return;

  insertMovement(db, {
    accountId: input.accountId,
    direction: 'out',
    amountCve: amount,
    movementDate: input.movementDate,
    kind: input.kind,
    expenseId: input.kind === 'despesa' ? input.sourceId : null,
    investmentId: input.kind === 'investimento' ? input.sourceId : null,
    description: input.description,
    userId: input.userId
  });
}

/** Valida a conta de uma saída antes de abrir a transação. */
export function validatePayingAccount(db: Database, accountId: number | null | undefined): TreasuryResult<number | null> {
  if (accountId === null || accountId === undefined) return { ok: true, value: null };
  const account = getAccount(db, accountId);
  if (!account || !account.active) return fail(400, 'Conta de pagamento inexistente ou desativada.');
  return { ok: true, value: account.id };
}

// ---------------------------------------------------------------------------
// Depósitos, transferências, contagens, estornos manuais
// ---------------------------------------------------------------------------

export function createTransfer(db: Database, input: {
  fromAccountId: number;
  toAccountId: number;
  amountCve: number;
  movementDate?: string;
  reference?: string | null;
  notes?: string | null;
  allowNegative?: boolean;
  userId?: number | null;
}): TreasuryResult<{ kind: 'deposito' | 'transferencia'; transferGroup: string; from: TreasuryAccount; to: TreasuryAccount; amountCve: number }> {
  if (input.fromAccountId === input.toAccountId) return fail(400, 'A conta de origem e a de destino tem de ser diferentes.');
  const from = getAccount(db, input.fromAccountId);
  const to = getAccount(db, input.toAccountId);
  if (!from || !from.active) return fail(400, 'Conta de origem inexistente ou desativada.');
  if (!to || !to.active) return fail(400, 'Conta de destino inexistente ou desativada.');
  const amount = validAmount(input.amountCve);
  if (amount === null) return fail(400, 'O valor tem de ser positivo.');
  const date = input.movementDate ?? todayIso();
  if (!ISO_DATE.test(date)) return fail(400, 'Data invalida.');
  if (date > todayIso()) return fail(400, 'A data nao pode ser futura.');
  if (!input.allowNegative && escudosToCentavos(from.balanceCve) < escudosToCentavos(amount)) {
    return fail(409, `Saldo insuficiente em ${from.name}: tem ${from.balanceCve.toFixed(2)} e pediu ${amount.toFixed(2)}.`);
  }

  // Caixa → banco é um depósito; o resto é uma transferência entre contas.
  const kind = from.kind === 'caixa' && to.kind === 'banco' ? 'deposito' : 'transferencia';
  const label = kind === 'deposito' ? 'Deposito' : 'Transferencia';
  const notes = clean(input.notes);
  const group = randomUUID();

  db.transaction(() => {
    insertMovement(db, {
      accountId: from.id, direction: 'out', amountCve: amount, movementDate: date, kind,
      transferGroup: group, reference: input.reference,
      description: `${label} para ${to.name}${notes ? ` — ${notes}` : ''}`, userId: input.userId
    });
    insertMovement(db, {
      accountId: to.id, direction: 'in', amountCve: amount, movementDate: date, kind,
      transferGroup: group, reference: input.reference,
      description: `${label} de ${from.name}${notes ? ` — ${notes}` : ''}`, userId: input.userId
    });
  })();

  return { ok: true, value: { kind, transferGroup: group, from: getAccount(db, from.id)!, to: getAccount(db, to.id)!, amountCve: amount } };
}

/**
 * Contagem de caixa: o que está na gaveta contra o que o sistema diz.
 *
 * Bater certo não lança nada. Não bater lança um ajuste pela diferença, com
 * motivo — é assim que uma falta ou uma sobra fica explicada em vez de
 * escondida num saldo de abertura reescrito.
 */
export function recordCashCount(db: Database, input: {
  accountId: number;
  countedCve: number;
  movementDate?: string;
  reason?: string | null;
  userId?: number | null;
}): TreasuryResult<{ account: TreasuryAccount; systemCve: number; countedCve: number; differenceCve: number; movementId: number | null }> {
  const account = getAccount(db, input.accountId);
  if (!account || !account.active) return fail(400, 'Conta inexistente ou desativada.');
  const counted = roundEscudos(input.countedCve);
  if (!Number.isFinite(counted) || counted < 0) return fail(400, 'O valor contado tem de ser zero ou positivo.');
  const date = input.movementDate ?? todayIso();
  if (!ISO_DATE.test(date) || date > todayIso()) return fail(400, 'Data invalida.');

  const system = account.balanceCve;
  const differenceCents = escudosToCentavos(counted) - escudosToCentavos(system);
  if (differenceCents === 0) {
    return { ok: true, value: { account, systemCve: system, countedCve: counted, differenceCve: 0, movementId: null } };
  }

  const reason = input.reason?.trim() || '';
  if (reason.length < 10) {
    return fail(400, 'A contagem nao bate com o saldo: explique a diferenca (minimo 10 caracteres).');
  }

  const difference = differenceCents / 100;
  const movementId = db.transaction(() => insertMovement(db, {
    accountId: account.id,
    direction: differenceCents > 0 ? 'in' : 'out',
    amountCve: Math.abs(difference),
    movementDate: date,
    kind: 'ajuste',
    description: `${differenceCents > 0 ? 'Sobra' : 'Falta'} na contagem (sistema ${system.toFixed(2)}, contado ${counted.toFixed(2)}) — ${reason}`,
    userId: input.userId
  }))();

  return {
    ok: true,
    value: { account: getAccount(db, account.id)!, systemCve: system, countedCve: counted, differenceCve: difference, movementId }
  };
}

/**
 * Estorno manual. Só para o que nasceu na tesouraria (depósitos, transferências,
 * ajustes): um recebimento corrige-se anulando o recibo, e uma despesa editando
 * ou apagando a despesa — senão o documento e o saldo deixavam de concordar.
 */
export function reverseMovement(db: Database, id: number, rawReason: string | null | undefined, userId?: number | null): TreasuryResult<{ reversed: TreasuryMovement[] }> {
  const movement = loadMovement(db, id);
  if (!movement) return fail(404, 'Movimento nao encontrado');
  if (movement.kind === 'estorno') return fail(400, 'Um estorno nao se estorna: lance o movimento de novo.');
  if (movement.reversedById) return fail(400, 'Este movimento ja foi estornado.');
  if (movement.kind === 'recebimento') return fail(400, 'Para desfazer um recebimento, anule o recibo em Financeiro.');
  if (movement.kind === 'despesa' || movement.kind === 'investimento') {
    return fail(400, 'Esta saida vem de uma despesa ou investimento: corrija-a la.');
  }
  const reason = rawReason?.trim() || '';
  if (reason.length < 10) return fail(400, 'Estornar exige um motivo detalhado (minimo 10 caracteres).');

  // Um depósito ou transferência tem dois lados: estornar um só deixava dinheiro
  // a aparecer do nada numa das contas.
  const targets = movement.transferGroup
    ? (db.prepare(`${movementSelect} WHERE m.transfer_group = ? AND m.kind <> 'estorno'`).all(movement.transferGroup) as TreasuryMovement[])
    : [movement];

  db.transaction(() => {
    for (const target of targets) {
      if (!target.reversedById) reverseInTransaction(db, target, reason, todayIso(), userId);
    }
  })();

  return { ok: true, value: { reversed: targets } };
}

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

export function treasurySummary(db: Database, month = todayIso().slice(0, 7)) {
  const accounts = listAccounts(db);
  const active = accounts.filter((a) => a.active);
  const sum = (list: TreasuryAccount[]) => list.reduce((cents, a) => cents + escudosToCentavos(a.balanceCve), 0) / 100;
  const flows = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN m.direction = 'in' AND m.transfer_group IS NULL THEN m.amount_cve END), 0) AS inCve,
      COALESCE(SUM(CASE WHEN m.direction = 'out' AND m.transfer_group IS NULL THEN m.amount_cve END), 0) AS outCve
    FROM treasury_movements m
    JOIN treasury_accounts a ON a.id = m.account_id
    WHERE substr(m.movement_date, 1, 7) = ? AND m.movement_date >= a.opening_date
  `).get(month) as { inCve: number; outCve: number };

  return {
    month,
    totalCve: sum(active),
    cashCve: sum(active.filter((a) => a.kind === 'caixa')),
    bankCve: sum(active.filter((a) => a.kind === 'banco')),
    // Entradas e saídas reais: depósitos e transferências (e os seus estornos,
    // que herdam o transfer_group) só mudam o dinheiro de sítio.
    monthInCve: roundEscudos(flows.inCve),
    monthOutCve: roundEscudos(flows.outCve),
    accounts
  };
}
