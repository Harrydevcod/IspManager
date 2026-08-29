import { Button, Dialog, Textarea } from '../../components';
import { formatCve, formatPtDate } from '../../lib/format';
import type { PaymentReceipt } from '../../types';

/**
 * Anular um recebimento mal lancado.
 *
 * O motivo e obrigatorio e a barra e a mesma do backend (10 caracteres): o
 * numero de recibo fica queimado na serie e alguem, um dia, vai querer saber
 * porque. Deixar passar "erro" era nao deixar rasto nenhum.
 */
const MIN_REASON = 10;

type VoidReceiptDialogProps = {
  receipt: PaymentReceipt | null;
  reason: string;
  submitting: boolean;
  onReasonChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function VoidReceiptDialog({
  receipt,
  reason,
  submitting,
  onReasonChange,
  onClose,
  onConfirm
}: VoidReceiptDialogProps) {
  const tooShort = reason.trim().length < MIN_REASON;

  return (
    <Dialog
      open={!!receipt}
      onClose={onClose}
      eyebrow="Anular recebimento"
      title={receipt ? receipt.receiptNumber : 'Anular recebimento'}
      size="sm"
      closeOnBackdrop={!submitting}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button variant="danger" onClick={onConfirm} disabled={submitting || tooShort}>
            {submitting ? 'A anular...' : 'Anular recebimento'}
          </Button>
        </>
      }
    >
      {receipt && (
        <div className="overdue-notify">
          <p className="overdue-notify-summary">
            Vai anular <strong>{formatCve(receipt.amountCve)}</strong> recebidos em{' '}
            <strong>{formatPtDate(receipt.paymentDate)}</strong>. O número{' '}
            <strong>{receipt.receiptNumber}</strong> fica na série, anulado — não se reutiliza.
            Se a fatura estava fechada, reabre com o saldo em dívida.
          </p>
          <Textarea
            label="Motivo"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            rows={3}
            disabled={submitting}
            required
          />
          {tooShort && <p className="module-message">Escreva pelo menos {MIN_REASON} caracteres.</p>}
        </div>
      )}
    </Dialog>
  );
}
