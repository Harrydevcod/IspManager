import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { businessDay, sqlBusinessDate } from '../../shared/business-day';
import { roundEscudos } from '../../shared/money';
import { MAX_INSTALLMENTS, MIN_INSTALLMENTS, monthlyDueDates, PLAN_GRACE_DAYS, splitInstallments } from '../../shared/payment-plan';
import { balanceSqlExpr, type PaymentOpResult } from './payments';

/**
 * Acordo de pagamento (0103): um calendário de prestações por cima de faturas em aberto.
 *
 * As faturas não mudam — os recibos continuam a cair nelas. O pago do acordo é o que as faturas
 * abrangidas deixaram de dever desde que ele nasceu (recibos e crédito aplicado contam; uma fatura
 * anulada conta como perdoada). Em dia = cobre tudo o que já venceu no calendário.
 *
 * Enquanto em dia, as faturas abrangidas saem do corte automático e dos avisos de cobrança
 * (`planProtectedSql`). Uma prestação por pagar `PLAN_GRACE_DAYS` dias depois do vencimento tira a proteção sozinha:
 * o funil normal retoma sem ninguém ter de lembrar.
 */

export const createPaymentPlanSchema = z.object({
  paymentIds: z.array(z.number().int().positive()).min(1).max(200),
  installments: z.number().int().min(MIN_INSTALLMENTS).max(MAX_INSTALLMENTS),
  firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional().nullable()
});
export type CreatePaymentPlanInput = z.infer<typeof createPaymentPlanSchema>;

export const cancelPaymentPlanSchema = z.object({
  reason: z.string().trim().min(1).max(300)
});

export type PaymentPlanStatus = 'em_dia' | 'em_atraso' | 'cumprido' | 'cancelado';
export type InstallmentStatus = 'paga' | 'por_pagar' | 'em_atraso';

export type PaymentPlanInstallment = {
  seq: number;
  dueDate: string;
  amountCve: number;
  status: InstallmentStatus;
};

export type PaymentPlanView = {
  id: number;
  clientId: number;
  totalCve: number;
  paidCve: number;
  remainingCve: number;
  /** Prestações já vencidas que o pago ainda não cobre. */
  arrearsCve: number;
  status: PaymentPlanStatus;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  invoices: Array<{ paymentId: number; invoiceNumber: string | null; referenceMonth: string; balanceCve: number }>;
  installments: PaymentPlanInstallment[];
};

/** O que as faturas do acordo ainda devem: anuladas contam zero, saldo negativo nunca abate. */
function planRemainingSql(planAlias: string): string {
  return `COALESCE((
    SELECT SUM(MAX(${balanceSqlExpr('ppx')}, 0))
    FROM payment_plan_invoices ppix
    JOIN payments ppx ON ppx.id = ppix.payment_id
    WHERE ppix.plan_id = ${planAlias}.id AND ppx.status <> 'cancelled'
  ), 0)`;
}

/**
 * Fatura que NÃO está num acordo ativo em dia. Entra no WHERE do corte automático e dos avisos.
 * Em dia: as prestações vencidas antes de hoje somam no máximo o que já foi pago.
 */
export function planProtectedSql(paymentAlias: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM payment_plan_invoices ppi
    JOIN payment_plans pp ON pp.id = ppi.plan_id
    WHERE ppi.payment_id = ${paymentAlias}.id
      AND pp.status = 'active'
      AND COALESCE((
        SELECT SUM(ins.amount_cve) FROM payment_plan_installments ins
        WHERE ins.plan_id = pp.id AND date(ins.due_date) < ${sqlBusinessDate(`'-${PLAN_GRACE_DAYS} days'`)}
      ), 0) <= pp.total_cve - ${planRemainingSql('pp')} + 0.005
  )`;
}

function planLateBefore(): string {
  return businessDay(Date.now() - PLAN_GRACE_DAYS * 86_400_000);
}

function isValidIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function createPaymentPlan(
  db: Database,
  clientId: number,
  input: CreatePaymentPlanInput,
  userId: number | null
): PaymentOpResult<PaymentPlanView> {
  const paymentIds = [...new Set(input.paymentIds)];
  if (!isValidIsoDate(input.firstDueDate)) {
    return { ok: false, status: 400, error: 'Data da 1.ª prestação inválida' };
  }
  if (input.firstDueDate < businessDay()) {
    return { ok: false, status: 400, error: 'A 1.ª prestação não pode ser no passado' };
  }
  const client = db.prepare('SELECT id FROM clients WHERE id = ? AND system_kind IS NULL').get(clientId);
  if (!client) return { ok: false, status: 404, error: 'Cliente não encontrado' };

  const create = db.transaction((): PaymentOpResult<number> => {
    let total = 0;
    for (const paymentId of paymentIds) {
      const row = db.prepare(`
        SELECT p.client_id AS clientId, p.status, ${balanceSqlExpr('p')} AS balanceCve,
          EXISTS (
            SELECT 1 FROM payment_plan_invoices ppi JOIN payment_plans pp ON pp.id = ppi.plan_id
            WHERE ppi.payment_id = p.id AND pp.status = 'active'
          ) AS inPlan
        FROM payments p WHERE p.id = ?
      `).get(paymentId) as { clientId: number; status: string; balanceCve: number; inPlan: number } | undefined;
      if (!row || row.clientId !== clientId) {
        return { ok: false, status: 400, error: 'Fatura não pertence a este cliente' };
      }
      if (row.status === 'cancelled' || row.balanceCve <= 0.005) {
        return { ok: false, status: 400, error: 'Só entram faturas com saldo em aberto' };
      }
      if (row.inPlan) {
        return { ok: false, status: 409, error: 'Uma das faturas já está noutro acordo ativo' };
      }
      total += row.balanceCve;
    }
    total = roundEscudos(total);
    if (total < input.installments) {
      return { ok: false, status: 400, error: 'Valor demasiado baixo para tantas prestações' };
    }

    const planId = Number(db.prepare(`
      INSERT INTO payment_plans (client_id, total_cve, notes, created_by) VALUES (?, ?, ?, ?)
    `).run(clientId, total, input.notes || null, userId).lastInsertRowid);
    const linkInvoice = db.prepare('INSERT INTO payment_plan_invoices (plan_id, payment_id) VALUES (?, ?)');
    for (const paymentId of paymentIds) linkInvoice.run(planId, paymentId);
    const amounts = splitInstallments(total, input.installments);
    const dates = monthlyDueDates(input.firstDueDate, input.installments);
    const addInstallment = db.prepare(`
      INSERT INTO payment_plan_installments (plan_id, seq, due_date, amount_cve) VALUES (?, ?, ?, ?)
    `);
    amounts.forEach((amount, i) => addInstallment.run(planId, i + 1, dates[i], amount));
    return { ok: true, value: planId };
  });

  const result = create.immediate();
  if (!result.ok) return result;
  return { ok: true, value: loadPaymentPlan(db, result.value)! };
}

export function cancelPaymentPlan(db: Database, planId: number, reason: string): PaymentOpResult<PaymentPlanView> {
  const changed = db.prepare(`
    UPDATE payment_plans SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ?
    WHERE id = ? AND status = 'active'
  `).run(reason, planId).changes;
  const plan = loadPaymentPlan(db, planId);
  if (!plan) return { ok: false, status: 404, error: 'Acordo não encontrado' };
  if (!changed) return { ok: false, status: 409, error: 'O acordo já estava cancelado' };
  return { ok: true, value: plan };
}

type PlanRow = {
  id: number;
  clientId: number;
  totalCve: number;
  remainingCve: number;
  status: 'active' | 'cancelled';
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
};

// Função: `payments` importa `auto-suspension`, que importa este módulo — nada de SQL ao carregar.
const planSelect = () => `
  SELECT pp.id, pp.client_id AS clientId, pp.total_cve AS totalCve, ${planRemainingSql('pp')} AS remainingCve,
    pp.status, pp.notes, pp.created_at AS createdAt, u.username AS createdBy,
    pp.cancelled_at AS cancelledAt, pp.cancel_reason AS cancelReason
  FROM payment_plans pp
  LEFT JOIN users u ON u.id = pp.created_by
`;

/** `lateBefore`: uma prestação vencida antes deste dia e por pagar está em atraso (passou a folga). */
function toView(db: Database, row: PlanRow, lateBefore: string): PaymentPlanView {
  const remainingCve = roundEscudos(Math.min(row.remainingCve, row.totalCve));
  const paidCve = roundEscudos(row.totalCve - remainingCve);
  const installmentRows = db.prepare(`
    SELECT seq, due_date AS dueDate, amount_cve AS amountCve
    FROM payment_plan_installments WHERE plan_id = ? ORDER BY seq
  `).all(row.id) as Array<{ seq: number; dueDate: string; amountCve: number }>;

  let cumulative = 0;
  let dueSoFar = 0;
  const installments = installmentRows.map((ins): PaymentPlanInstallment => {
    cumulative += ins.amountCve;
    if (ins.dueDate < lateBefore) dueSoFar += ins.amountCve;
    const status: InstallmentStatus = paidCve + 0.005 >= cumulative
      ? 'paga'
      : ins.dueDate < lateBefore ? 'em_atraso' : 'por_pagar';
    return { ...ins, status };
  });
  const arrearsCve = roundEscudos(Math.max(0, dueSoFar - paidCve));

  const status: PaymentPlanStatus = row.status === 'cancelled'
    ? 'cancelado'
    : remainingCve <= 0.005 ? 'cumprido' : arrearsCve > 0.005 ? 'em_atraso' : 'em_dia';

  const invoices = db.prepare(`
    SELECT p.id AS paymentId, p.invoice_number AS invoiceNumber, p.reference_month AS referenceMonth,
      CASE WHEN p.status = 'cancelled' THEN 0 ELSE MAX(${balanceSqlExpr('p')}, 0) END AS balanceCve
    FROM payment_plan_invoices ppi JOIN payments p ON p.id = ppi.payment_id
    WHERE ppi.plan_id = ? ORDER BY p.due_date, p.id
  `).all(row.id) as PaymentPlanView['invoices'];

  return {
    ...row,
    totalCve: roundEscudos(row.totalCve),
    paidCve,
    remainingCve,
    arrearsCve,
    status,
    invoices: invoices.map((i) => ({ ...i, balanceCve: roundEscudos(i.balanceCve) })),
    installments
  };
}

export function loadPaymentPlan(db: Database, planId: number): PaymentPlanView | null {
  const row = db.prepare(`${planSelect()} WHERE pp.id = ?`).get(planId) as PlanRow | undefined;
  return row ? toView(db, row, planLateBefore()) : null;
}

/** Acordos do cliente, o mais recente primeiro. */
export function listClientPaymentPlans(db: Database, clientId: number): PaymentPlanView[] {
  const lateBefore = planLateBefore();
  const rows = db.prepare(`${planSelect()} WHERE pp.client_id = ? ORDER BY pp.id DESC`).all(clientId) as PlanRow[];
  return rows.map((row) => toView(db, row, lateBefore));
}
