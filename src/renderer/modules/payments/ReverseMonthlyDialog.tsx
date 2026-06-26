import { Badge, Button, Dialog, Message } from '../../components';
import { formatCve, formatPtDate, formatPtMonth } from '../../lib/format';

export type ReverseMonthlyPreview = {
  referenceMonth: string;
  total: number;
  eligibleCount: number;
  paidLockedCount: number;
  cancelledCount: number;
  totalCve: number;
  eligible: Array<{ id: number; clientName: string; clientCode: string | null; invoiceNumber: string | null; amountCve: number; dueDate: string; status: 'pending' | 'overdue' }>;
  paidLocked: Array<{ id: number; clientName: string; clientCode: string | null; invoiceNumber: string | null; amountCve: number }>;
};

type ReverseMonthlyDialogProps = {
  preview: ReverseMonthlyPreview | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function ReverseMonthlyDialog({ preview, submitting, onClose, onConfirm }: ReverseMonthlyDialogProps) {
  return (
    <Dialog
      open={!!preview}
      onClose={onClose}
      eyebrow="Reverter geracao"
      title={preview ? `Mensalidades de ${formatPtMonth(preview.referenceMonth)}` : 'Reverter mensalidades'}
      size="md"
      closeOnBackdrop={!submitting}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button
            onClick={onConfirm}
            disabled={submitting || !preview || preview.eligibleCount === 0}
          >
            {submitting
              ? 'A reverter...'
              : preview && preview.eligibleCount > 0
                ? `Reverter ${preview.eligibleCount} cobranca(s)`
                : 'Nada a reverter'}
          </Button>
        </>
      }
    >
      {preview && (
        <div className="overdue-notify">
          <p className="overdue-notify-summary">
            <strong>{preview.total}</strong> cobranca(s) em {formatPtMonth(preview.referenceMonth)}.{' '}
            <strong>{preview.eligibleCount}</strong> serao apagadas ({formatCve(preview.totalCve)}).{' '}
            {preview.paidLockedCount > 0 && (
              <span className="overdue-notify-skip">
                {preview.paidLockedCount} pagas ficam intactas (anular se necessario).
              </span>
            )}
            {preview.cancelledCount > 0 && (
              <span className="overdue-notify-skip">
                {' '}{preview.cancelledCount} ja anuladas.
              </span>
            )}
          </p>

          {preview.eligibleCount > 0 ? (
            <ul className="overdue-notify-list">
              {preview.eligible.map((row) => (
                <li key={row.id}>
                  <div className="overdue-notify-meta">
                    <small className="entity-code">{row.clientCode || '—'}</small>
                    <strong>{row.clientName}</strong>
                    <small>FT {row.invoiceNumber || '-'} · venc. {formatPtDate(row.dueDate)}</small>
                  </div>
                  <Badge tone={row.status === 'overdue' ? 'danger' : 'info'}>{row.status}</Badge>
                  <span className="overdue-notify-amount">{formatCve(row.amountCve)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Message>
              Sem cobrancas pendentes ou em atraso para reverter em {formatPtMonth(preview.referenceMonth)}.
            </Message>
          )}

          {preview.paidLockedCount > 0 && (
            <details className="overdue-notify-skipped">
              <summary>Pagas ({preview.paidLockedCount}) - nao serao apagadas</summary>
              <ul>
                {preview.paidLocked.map((row) => (
                  <li key={row.id}>
                    {row.clientName} <small>(FT {row.invoiceNumber || '-'} - {formatCve(row.amountCve)})</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Dialog>
  );
}
