import { Button, Dialog, Field, Textarea } from '../../components';
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
  /**
   * Reembolso Stripe: além de anular, devolve o dinheiro ao cartão. É dinheiro
   * a sair, por isso pede a password outra vez (a barra é a do backend).
   */
  refund?: { password: string; onPasswordChange: (password: string) => void };
  onClose: () => void;
  onConfirm: () => void;
};

export function VoidReceiptDialog({
  receipt,
  reason,
  submitting,
  onReasonChange,
  refund,
  onClose,
  onConfirm
}: VoidReceiptDialogProps) {
  const tooShort = reason.trim().length < MIN_REASON;
  const verb = refund ? 'Reembolsar' : 'Anular';

  return (
    <Dialog
      open={!!receipt}
      onClose={onClose}
      eyebrow={refund ? 'Reembolsar no Stripe' : 'Anular recebimento'}
      title={receipt ? receipt.receiptNumber : `${verb} recebimento`}
      size="sm"
      closeOnBackdrop={!submitting}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button variant="danger" onClick={onConfirm} disabled={submitting || tooShort || (refund !== undefined && !refund.password)}>
            {submitting ? (refund ? 'A reembolsar...' : 'A anular...') : refund ? 'Reembolsar e anular' : 'Anular recebimento'}
          </Button>
        </>
      }
    >
      {receipt && (
        <div className="overdue-notify">
          {refund ? (
            <p className="overdue-notify-summary">
              Vai devolver <strong>{formatCve(receipt.amountCve)}</strong> ao cartão do cliente, pelo Stripe,
              e anular o recibo <strong>{receipt.receiptNumber}</strong>. Um reembolso não se desfaz. A fatura
              reabre com o saldo em dívida, e a comissão que o Stripe cobrou não é devolvida: a despesa fica.
            </p>
          ) : (
            <p className="overdue-notify-summary">
              Vai anular <strong>{formatCve(receipt.amountCve)}</strong> recebidos em{' '}
              <strong>{formatPtDate(receipt.paymentDate)}</strong>. O número{' '}
              <strong>{receipt.receiptNumber}</strong> fica na série, anulado — não se reutiliza.
              Se a fatura estava fechada, reabre com o saldo em dívida.
            </p>
          )}
          <Textarea
            label="Motivo"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            rows={3}
            disabled={submitting}
            required
          />
          {tooShort && <p className="module-message">Escreva pelo menos {MIN_REASON} caracteres.</p>}
          {refund && (
            <Field
              label="A sua password"
              type="password"
              autoComplete="current-password"
              value={refund.password}
              onChange={(event) => refund.onPasswordChange(event.target.value)}
              disabled={submitting}
              required
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
