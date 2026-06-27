import { Button, Dialog } from '../../components';
import { formatCve, formatPtMonth } from '../../lib/format';
import type { PaymentRow } from '../../types';

type IndividualRevertDialogProps = {
  payment: PaymentRow | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function IndividualRevertDialog({ payment, submitting, onClose, onConfirm }: IndividualRevertDialogProps) {
  return (
    <Dialog
      open={!!payment}
      onClose={onClose}
      eyebrow="Reverter cobranca"
      title={payment ? `${payment.clientName} - ${formatPtMonth(payment.referenceMonth)}` : 'Reverter cobranca'}
      size="sm"
      closeOnBackdrop={!submitting}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button onClick={onConfirm} disabled={submitting}>
            {submitting ? 'A reverter...' : 'Confirmar reversao'}
          </Button>
        </>
      }
    >
      {payment && (
        <div className="overdue-notify">
          <p className="overdue-notify-summary">
            Vai apagar a cobranca <strong>FT {payment.invoiceNumber || payment.id}</strong>{' '}
            de <strong>{payment.clientName}</strong> ({formatCve(payment.amountCve)}).
            Esta accao nao pode ser desfeita. Se a cobranca foi enviada ao cliente, considere anular em vez de reverter.
          </p>
        </div>
      )}
    </Dialog>
  );
}
