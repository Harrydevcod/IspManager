import { formatCve } from '../../lib/format';

export type PaymentTotalsValue = {
  pending: { count: number; sum: number };
  overdue: { count: number; sum: number };
  paid: { count: number; sum: number };
};

type PaymentsTotalsProps = {
  totals: PaymentTotalsValue;
};

export function PaymentsTotals({ totals }: PaymentsTotalsProps) {
  return (
    <div className="payments-totals" aria-label="Totais do periodo">
      <span className="payments-totals-label">Totais do período</span>
      <span className="payments-total-chip pending">
        <small>Pendente</small>
        <strong>{formatCve(totals.pending.sum)}</strong>
        <em>{totals.pending.count}</em>
      </span>
      <span className="payments-total-chip overdue">
        <small>Atraso</small>
        <strong>{formatCve(totals.overdue.sum)}</strong>
        <em>{totals.overdue.count}</em>
      </span>
      <span className="payments-total-chip paid">
        <small>Pago</small>
        <strong>{formatCve(totals.paid.sum)}</strong>
        <em>{totals.paid.count}</em>
      </span>
    </div>
  );
}
