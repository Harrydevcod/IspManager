import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Message, Select } from '../../components';
import type { PaymentMethod } from './PaymentDetailDialog';

export type BulkPaymentMode = 'pay' | 'cancel';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

type BulkPaymentDialogProps = {
  mode: BulkPaymentMode | null;
  count: number;
  submitting: boolean;
  onClose: () => void;
  onConfirmPay: (method: PaymentMethod, date: string) => void;
  onConfirmCancel: (reason: string) => void;
};

/** Diálogo único para as ações em massa de pagamentos: registar pago ou anular. */
export function BulkPaymentDialog({ mode, count, submitting, onClose, onConfirmPay, onConfirmCancel }: BulkPaymentDialogProps) {
  const [method, setMethod] = useState<PaymentMethod>('numerario');
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');

  if (!mode) return null;

  const isPay = mode === 'pay';
  const reasonTooShort = reason.trim().length < 10;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPay) onConfirmPay(method, date);
    else if (!reasonTooShort) onConfirmCancel(reason.trim());
  }

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Ações em massa"
      title={isPay ? `Registar pagamento · ${count} cobrança(s)` : `Anular · ${count} cobrança(s)`}
      size="sm"
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button
            type="submit"
            form="bulk-payment-form"
            variant={isPay ? 'primary' : 'danger'}
            disabled={submitting || (!isPay && reasonTooShort)}
          >
            {isPay ? 'Confirmar pagamentos' : 'Anular cobranças'}
          </Button>
        </>
      }
    >
      <form id="bulk-payment-form" className="overdue-notify" onSubmit={submit}>
        {isPay ? (
          <>
            <Message tone="neutral">
              O mesmo método e data são aplicados às {count} cobranças selecionadas. Já pagas/anuladas são ignoradas.
            </Message>
            <Select label="Método" value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)} disabled={submitting}>
              <option value="numerario">Numerário</option>
              <option value="transferencia">Transferência</option>
              <option value="outro">Outro</option>
            </Select>
            <Field label="Data" type="date" value={date} max={todayIso()} onChange={(event) => setDate(event.target.value)} disabled={submitting} required />
          </>
        ) : (
          <>
            <Message tone="error">
              Anulação é definitiva (não apaga — regista a anulação fiscal). Aplica-se às {count} cobranças selecionadas.
            </Message>
            <Field
              label="Motivo da anulação"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Mínimo 10 caracteres"
              disabled={submitting}
              required
            />
          </>
        )}
      </form>
    </Dialog>
  );
}
