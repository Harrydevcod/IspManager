import { Printer, Undo2, Wallet } from 'lucide-react';
import { Badge, Button, EmptyState } from '../../components';
import { formatCve, formatPtDate } from '../../lib/format';
import type { PaymentReceipt } from '../../types';

/**
 * O historico do dinheiro de uma fatura.
 *
 * Cada linha e um documento com numero proprio, por isso nenhuma desaparece:
 * um recibo anulado fica na lista, riscado e com o motivo a vista. Esconde-lo
 * dava a ideia de que o numero nunca existiu, e a serie tem de se explicar.
 */
type ReceiptsSectionProps = {
  receipts: PaymentReceipt[];
  clientCreditCve: number;
  balanceCve: number;
  submitting: boolean;
  onPrintReceipt: (receipt: PaymentReceipt) => void;
  onVoidReceipt: (receipt: PaymentReceipt) => void;
  onApplyCredit: () => void;
};

const METHOD_LABELS: Record<string, string> = {
  numerario: 'Numerário',
  transferencia: 'Transferência',
  outro: 'Outro'
};

export function ReceiptsSection({
  receipts,
  clientCreditCve,
  balanceCve,
  submitting,
  onPrintReceipt,
  onVoidReceipt,
  onApplyCredit
}: ReceiptsSectionProps) {
  const canUseCredit = clientCreditCve > 0 && balanceCve > 0;

  return (
    <section className="receipts-section">
      <header className="receipts-section__header">
        <p className="eyebrow">Recebimentos</p>
        {canUseCredit && (
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Wallet size={16} aria-hidden />}
            onClick={onApplyCredit}
            disabled={submitting}
            title="Abater o crédito disponível do cliente nesta fatura"
          >
            Usar crédito ({formatCve(clientCreditCve)})
          </Button>
        )}
      </header>

      {receipts.length === 0 ? (
        <EmptyState title="Sem recebimentos" description="Ainda não entrou dinheiro por conta desta fatura." />
      ) : (
        <ul className="receipts-list">
          {receipts.map((receipt) => {
            const voided = Boolean(receipt.voidedAt);
            return (
              <li key={receipt.id} className={`receipts-row${voided ? ' receipts-row--voided' : ''}`}>
                <span className="receipts-row__main">
                  <strong>{formatCve(receipt.amountCve)}</strong>
                  <small>
                    {formatPtDate(receipt.paymentDate)} · {METHOD_LABELS[receipt.paymentMethod] || receipt.paymentMethod} · {receipt.receiptNumber}
                  </small>
                  {voided && receipt.voidReason && <small className="receipts-row__reason">{receipt.voidReason}</small>}
                </span>
                <span className="receipts-row__tags">
                  {receipt.source === 'credit' && <Badge tone="info">Conta corrente</Badge>}
                  {voided && <Badge tone="neutral">Anulado</Badge>}
                </span>
                <span className="receipts-row__actions">
                  {!voided && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        leadingIcon={<Printer size={16} aria-hidden />}
                        onClick={() => onPrintReceipt(receipt)}
                        title={`Imprimir o recibo ${receipt.receiptNumber}`}
                      >
                        Recibo
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        leadingIcon={<Undo2 size={16} aria-hidden />}
                        onClick={() => onVoidReceipt(receipt)}
                        disabled={submitting}
                        title="Anular este recebimento (exige motivo)"
                      >
                        Anular
                      </Button>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
