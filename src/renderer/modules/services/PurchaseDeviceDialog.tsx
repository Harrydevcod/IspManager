import { useState } from 'react';
import { Button, Dialog, Field, Message, Textarea } from '../../components';
import { formatCve } from '../../lib/format';
import type { DeviceAssignment } from '../../types';

type Props = {
  assignment: DeviceAssignment;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (amountCve: number, notes: string | null) => void;
};

/**
 * O cliente compra o equipamento que tinha alugado.
 *
 * O preço vem do catálogo mas é editável de propósito: equipamento com dois anos
 * de uso não se vende ao preço de novo, e zero é legítimo — oferecido ao fim de
 * contrato, ou já pago por fora.
 */
export function PurchaseDeviceDialog({ assignment, submitting, error, onClose, onConfirm }: Props) {
  const [amount, setAmount] = useState(String(assignment.sellingPriceCve || 0));
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);

  const amountCve = Number(amount);
  const invalid = !Number.isFinite(amountCve) || amountCve < 0;
  const label = assignment.brand ? `${assignment.brand} ${assignment.model}` : assignment.model;

  function confirm() {
    setTouched(true);
    if (invalid) return;
    onConfirm(amountCve, notes.trim() || null);
  }

  return (
    <Dialog
      open
      eyebrow="Equipamento"
      title={`Cliente compra ${label}`}
      onClose={onClose}
      closeOnBackdrop={!submitting}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button onClick={confirm} loading={submitting}>Confirmar compra</Button>
        </>
      )}
    >
      <div className="purchase-device">
        <p className="purchase-device-lead">
          O equipamento passa a ser do cliente e o aluguer de{' '}
          <strong>{formatCve(assignment.rentalFeeCve)}/mês</strong> deixa de entrar na fatura a partir
          da mensalidade seguinte. A fatura deste mês, se já foi emitida, não é alterada.
        </p>

        <Field
          label="Valor da compra"
          type="number"
          min={0}
          step={100}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={touched && invalid ? 'Indique um valor igual ou superior a zero' : undefined}
          hint={
            amountCve === 0
              ? 'Sem cobrança — o equipamento passa a ser do cliente na mesma'
              : `Preço de venda no catálogo: ${formatCve(assignment.sellingPriceCve)}`
          }
          autoFocus
        />

        <Textarea
          label="Notas"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Ex.: pago em dinheiro na loja"
        />

        {error ? <Message tone="error">{error}</Message> : null}
      </div>
    </Dialog>
  );
}
