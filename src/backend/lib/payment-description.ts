import type Database from 'better-sqlite3';
import { describePeriods, describeServiceLines, type PeriodSource, type ServiceLineSource } from '../../shared/message-describe';

export type PaymentDescription = { services: string; period: string };

type PaymentRow = PeriodSource & { id: number; planName: string | null };
type LineRow = ServiceLineSource & { paymentId: number };

const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Faturas e linhas de uma vez, em lotes: a lista de pagamentos pede milhares. */
function load(db: Database.Database, ids: number[]) {
  const payments = new Map<number, PaymentRow>();
  const lines = new Map<number, LineRow[]>();
  for (const part of chunks([...new Set(ids)])) {
    const marks = part.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT py.id, py.reference_month AS referenceMonth, py.invoice_date AS invoiceDate, py.due_date AS dueDate, pl.name AS planName
      FROM payments py LEFT JOIN services s ON s.id = py.service_id LEFT JOIN internet_plans pl ON pl.id = s.plan_id
      WHERE py.id IN (${marks})
    `).all(...part) as PaymentRow[]) payments.set(row.id, row);
    for (const row of db.prepare(`
      SELECT l.payment_id AS paymentId, l.kind, l.description, pl.name AS planName
      FROM payment_lines l JOIN payments py ON py.id = l.payment_id
      LEFT JOIN services s ON s.id = py.service_id LEFT JOIN internet_plans pl ON pl.id = s.plan_id
      WHERE l.payment_id IN (${marks}) ORDER BY l.payment_id, l.sort_order, l.id
    `).all(...part) as LineRow[]) lines.set(row.paymentId, [...(lines.get(row.paymentId) ?? []), row]);
  }
  return { payments, lines };
}

/** As linhas de uma fatura; as antigas, sem linhas, contam como a internet do plano do serviço. */
function linesOf(payment: PaymentRow, lines: Map<number, LineRow[]>): ServiceLineSource[] {
  const own = lines.get(payment.id);
  if (own?.length) return own;
  return payment.planName ? [{ kind: 'internet', description: '', planName: payment.planName }] : [];
}

/** O serviço e o período de cada fatura, por id. */
export function describePayments(db: Database.Database, ids: number[]): Map<number, PaymentDescription> {
  const { payments, lines } = load(db, ids);
  const out = new Map<number, PaymentDescription>();
  for (const payment of payments.values()) {
    out.set(payment.id, { services: describeServiceLines(linesOf(payment, lines)), period: describePeriods([payment]) });
  }
  return out;
}

/** O serviço e o período de várias faturas juntas (um recibo que liquidou várias). */
export function describePaymentGroup(db: Database.Database, ids: number[]): PaymentDescription {
  const { payments, lines } = load(db, ids);
  const rows = [...payments.values()].sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id - b.id);
  return { services: describeServiceLines(rows.flatMap((row) => linesOf(row, lines))), period: describePeriods(rows) };
}

/**
 * O que um recibo diz ao cliente: o valor recebido (não o da fatura) e o serviço e o período de
 * todas as faturas que liquidou. `null` quando o recibo não existe ou foi anulado.
 */
export function describeReceipt(db: Database.Database, receiptNumber: string): (PaymentDescription & { amountCve: number }) | null {
  const rows = db.prepare('SELECT payment_id AS paymentId, amount_cve AS amountCve FROM payment_receipts WHERE receipt_number = ? AND voided_at IS NULL')
    .all(receiptNumber) as Array<{ paymentId: number; amountCve: number }>;
  if (!rows.length) return null;
  const amountCve = Math.round(rows.reduce((sum, row) => sum + Number(row.amountCve), 0) * 100) / 100;
  return { amountCve, ...describePaymentGroup(db, rows.map((row) => row.paymentId)) };
}
