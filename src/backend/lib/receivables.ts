import type { Database } from 'better-sqlite3';
import { balanceSqlExpr, overdueSqlPredicate } from './payments';

/**
 * Read model da cobranca: quem deve o que, ha quanto tempo.
 *
 * Sem cache, como o painel de Operacao — a divida muda a cada recibo e um valor
 * de ha cinco minutos numa conversa de cobranca e pior do que valor nenhum.
 *
 * O que conta e o SALDO, nao o valor da fatura: uma fatura de 50.000 com 40.000
 * ja recebidos deve 10.000, e e isso que tem de aparecer a quem liga ao cliente.
 * Faturas anuladas e totalmente recebidas ficam de fora por construcao — o
 * saldo delas e zero.
 */

/** Baldes de antiguidade da divida, contados desde o vencimento. */
export type AgingBucket = 'current' | 'd30' | 'd60' | 'd90' | 'd90plus';

export const AGING_BUCKETS: AgingBucket[] = ['current', 'd30', 'd60', 'd90', 'd90plus'];

export type ReceivableInvoice = {
  paymentId: number;
  referenceMonth: string;
  invoiceNumber: string | null;
  dueDate: string;
  amountCve: number;
  receivedCve: number;
  balanceCve: number;
  daysOverdue: number;
  bucket: AgingBucket;
};

export type ReceivableClient = {
  clientId: number;
  clientName: string;
  clientCode: string | null;
  phone: string | null;
  zone: string | null;
  clientStatus: string;
  invoices: number;
  openCve: number;
  overdueCve: number;
  creditCve: number;
  oldestDueDate: string;
  maxDaysOverdue: number;
  bucket: AgingBucket;
};

export type ReceivablesReport = {
  generatedAt: string;
  totals: {
    openCve: number;
    overdueCve: number;
    notDueCve: number;
    clients: number;
    invoices: number;
    creditCve: number;
  };
  aging: Record<AgingBucket, { invoices: number; amountCve: number }>;
  clients: ReceivableClient[];
  invoices: ReceivableInvoice[];
};

/**
 * O balde e do dia mais atrasado do cliente: quem tem uma fatura de ha 120 dias
 * e outra de ontem esta no +90, que e o problema real. Classificar pela media
 * escondia exactamente o caso que se quer ver.
 */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd30';
  if (daysOverdue <= 60) return 'd60';
  if (daysOverdue <= 90) return 'd90';
  return 'd90plus';
}

const num = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;

export function loadReceivables(db: Database): ReceivablesReport {
  // Em aberto = ainda ha saldo e o documento nao esta anulado. O `> 0.005`
  // trava o residuo de virgula flutuante que sobra de somar REAL em escudos.
  const rows = db.prepare(`
    SELECT
      p.id AS paymentId,
      p.client_id AS clientId,
      c.full_name AS clientName,
      c.client_code AS clientCode,
      c.phone,
      c.zone,
      c.status AS clientStatus,
      p.reference_month AS referenceMonth,
      p.invoice_number AS invoiceNumber,
      p.due_date AS dueDate,
      p.amount_cve AS amountCve,
      COALESCE((
        SELECT SUM(r.amount_cve) FROM payment_receipts r
        WHERE r.payment_id = p.id AND r.voided_at IS NULL
      ), 0) AS receivedCve,
      ${balanceSqlExpr('p')} AS balanceCve,
      CAST(julianday('now') - julianday(p.due_date) AS INTEGER) AS daysOverdue,
      CASE WHEN ${overdueSqlPredicate('p')} THEN 1 ELSE 0 END AS isOverdue
    FROM payments p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status <> 'cancelled' AND ${balanceSqlExpr('p')} > 0.005
    ORDER BY p.due_date, c.full_name
  `).all() as Array<{
    paymentId: number;
    clientId: number;
    clientName: string;
    clientCode: string | null;
    phone: string | null;
    zone: string | null;
    clientStatus: string;
    referenceMonth: string;
    invoiceNumber: string | null;
    dueDate: string;
    amountCve: number;
    receivedCve: number;
    balanceCve: number;
    daysOverdue: number;
    isOverdue: number;
  }>;

  const credits = new Map<number, number>();
  for (const row of db.prepare(`
    SELECT client_id AS clientId, COALESCE(SUM(amount_cve), 0) AS creditCve
    FROM client_credits GROUP BY client_id HAVING creditCve > 0.005
  `).all() as Array<{ clientId: number; creditCve: number }>) {
    credits.set(row.clientId, num(row.creditCve));
  }

  const aging = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, { invoices: 0, amountCve: 0 }])
  ) as ReceivablesReport['aging'];

  const invoices: ReceivableInvoice[] = [];
  const byClient = new Map<number, ReceivableClient>();

  for (const row of rows) {
    const daysOverdue = Math.max(0, Number(row.daysOverdue) || 0);
    const bucket = agingBucket(daysOverdue);
    const balanceCve = num(row.balanceCve);

    invoices.push({
      paymentId: row.paymentId,
      referenceMonth: row.referenceMonth,
      invoiceNumber: row.invoiceNumber,
      dueDate: row.dueDate,
      amountCve: num(row.amountCve),
      receivedCve: num(row.receivedCve),
      balanceCve,
      daysOverdue,
      bucket
    });

    aging[bucket].invoices += 1;
    aging[bucket].amountCve = num(aging[bucket].amountCve + balanceCve);

    const existing = byClient.get(row.clientId);
    if (existing) {
      existing.invoices += 1;
      existing.openCve = num(existing.openCve + balanceCve);
      if (row.isOverdue) existing.overdueCve = num(existing.overdueCve + balanceCve);
      if (row.dueDate < existing.oldestDueDate) existing.oldestDueDate = row.dueDate;
      if (daysOverdue > existing.maxDaysOverdue) {
        existing.maxDaysOverdue = daysOverdue;
        existing.bucket = bucket;
      }
    } else {
      byClient.set(row.clientId, {
        clientId: row.clientId,
        clientName: row.clientName,
        clientCode: row.clientCode,
        phone: row.phone,
        zone: row.zone,
        clientStatus: row.clientStatus,
        invoices: 1,
        openCve: balanceCve,
        overdueCve: row.isOverdue ? balanceCve : 0,
        creditCve: credits.get(row.clientId) || 0,
        oldestDueDate: row.dueDate,
        maxDaysOverdue: daysOverdue,
        bucket
      });
    }
  }

  const clients = [...byClient.values()].sort(
    (a, b) => b.overdueCve - a.overdueCve || b.openCve - a.openCve || a.clientName.localeCompare(b.clientName)
  );

  const openCve = num(invoices.reduce((sum, i) => sum + i.balanceCve, 0));
  const overdueCve = num(clients.reduce((sum, c) => sum + c.overdueCve, 0));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      openCve,
      overdueCve,
      notDueCve: num(openCve - overdueCve),
      clients: clients.length,
      invoices: invoices.length,
      // Credito em circulacao: dinheiro do cliente que ainda nao foi abatido em
      // fatura nenhuma. Nao abate o que esta em aberto — sao contas separadas.
      creditCve: num([...credits.values()].reduce((sum, v) => sum + v, 0))
    },
    aging,
    clients,
    invoices
  };
}
