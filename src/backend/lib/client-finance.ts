import type { Database } from 'better-sqlite3';
import { roundEscudos } from '../../shared/money';
import { clientCreditBalance } from './payments';
import { loadReceivables, type ReceivableInvoice } from './receivables';
import { listClientPaymentPlans, type PaymentPlanView } from './payment-plans';

/**
 * Ficha financeira de um cliente: o que deve, o que pagou, o que lhe foi dito e o acordo.
 * Read model sem cache, como a carteira de Pendentes — muda a cada recibo.
 */

export type ClientFinanceReceipt = {
  id: number;
  paymentId: number;
  invoiceNumber: string | null;
  referenceMonth: string;
  receiptNumber: string;
  paymentDate: string;
  amountCve: number;
  paymentMethod: string;
  source: 'cash' | 'credit';
  voidedAt: string | null;
};

export type ClientFinanceNotice = {
  channel: 'whatsapp' | 'sms';
  id: number;
  kind: string;
  origin: string | null;
  status: string;
  at: string;
  paymentId: number | null;
  invoiceNumber: string | null;
  referenceMonth: string | null;
};

export type ClientFinance = {
  client: { id: number; name: string; code: string | null; phone: string | null; zone: string | null; status: string };
  summary: {
    openCve: number;
    overdueCve: number;
    overdueInvoices: number;
    creditCve: number;
    maxDaysOverdue: number;
    lastPaymentDate: string | null;
    lastPaymentCve: number | null;
  };
  invoices: Array<ReceivableInvoice & { planId: number | null }>;
  receipts: ClientFinanceReceipt[];
  notices: ClientFinanceNotice[];
  plans: PaymentPlanView[];
};

const HISTORY_LIMIT = 200;

export function loadClientFinance(db: Database, clientId: number): ClientFinance | null {
  const client = db.prepare(`
    SELECT id, full_name AS name, client_code AS code, phone, zone, status
    FROM clients WHERE id = ? AND system_kind IS NULL
  `).get(clientId) as ClientFinance['client'] | undefined;
  if (!client) return null;

  const receivables = loadReceivables(db, clientId);
  const head = receivables.clients[0];
  const plans = listClientPaymentPlans(db, clientId);
  const planByInvoice = new Map<number, number>();
  for (const plan of plans) {
    if (plan.status === 'cancelado') continue;
    for (const invoice of plan.invoices) planByInvoice.set(invoice.paymentId, plan.id);
  }
  const invoices = receivables.invoices.map((invoice) => ({
    ...invoice,
    planId: planByInvoice.get(invoice.paymentId) ?? null
  }));

  const receipts = db.prepare(`
    SELECT r.id, r.payment_id AS paymentId, p.invoice_number AS invoiceNumber, p.reference_month AS referenceMonth,
      r.receipt_number AS receiptNumber, r.payment_date AS paymentDate, r.amount_cve AS amountCve,
      r.payment_method AS paymentMethod, r.source, r.voided_at AS voidedAt
    FROM payment_receipts r
    JOIN payments p ON p.id = r.payment_id
    WHERE p.client_id = ?
    ORDER BY r.payment_date DESC, r.id DESC
    LIMIT ${HISTORY_LIMIT}
  `).all(clientId) as ClientFinanceReceipt[];
  const lastCash = receipts.find((r) => !r.voidedAt && r.source === 'cash');

  // WhatsApp do funil de cobrança e SMS (todos menos os de teste), numa só linha do tempo.
  const notices = db.prepare(`
    SELECT * FROM (
      SELECT 'whatsapp' AS channel, n.id, n.notice_type AS kind, n.origin, n.status, n.sent_at AS at,
        n.payment_id AS paymentId, p.invoice_number AS invoiceNumber, p.reference_month AS referenceMonth
      FROM whatsapp_notices n LEFT JOIN payments p ON p.id = n.payment_id
      WHERE n.client_id = ?
      UNION ALL
      SELECT 'sms', s.id, s.event_type, NULL, s.status, COALESCE(s.sent_at, s.created_at),
        s.payment_id, p.invoice_number, p.reference_month
      FROM sms_outbox s LEFT JOIN payments p ON p.id = s.payment_id
      WHERE s.client_id = ? AND s.event_type <> 'test'
    )
    ORDER BY at DESC, id DESC
    LIMIT ${HISTORY_LIMIT}
  `).all(clientId, clientId) as ClientFinanceNotice[];

  return {
    client,
    summary: {
      openCve: head?.openCve ?? 0,
      overdueCve: head?.overdueCve ?? 0,
      overdueInvoices: invoices.filter((i) => i.isOverdue).length,
      creditCve: clientCreditBalance(db, clientId),
      maxDaysOverdue: head?.maxDaysOverdue ?? 0,
      lastPaymentDate: lastCash?.paymentDate ?? null,
      lastPaymentCve: lastCash ? roundEscudos(lastCash.amountCve) : null
    },
    invoices,
    receipts: receipts.map((r) => ({ ...r, amountCve: roundEscudos(r.amountCve) })),
    notices,
    plans
  };
}
