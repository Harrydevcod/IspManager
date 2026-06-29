import type { FormEvent } from 'react';
import { CheckCircle2, FileText, MessageCircle, ReceiptText, RotateCcw, X } from 'lucide-react';
import { Button, Dialog, Field, Message, Select, Textarea } from '../../components';
import { formatCve, formatPtDate, formatPtMonth } from '../../lib/format';
import { normalizeWhatsappPhone } from '../../lib/whatsapp';
import type { PaymentRow } from '../../types';

export type PaymentMethod = 'numerario' | 'transferencia' | 'outro';
export type PaymentActionMode = 'pay' | 'cancel' | 'whatsapp';

const CANCEL_REASON_CHIPS_PENDING = [
  'Cobranca duplicada',
  'Cliente cancelou o servico',
  'Erro na geracao da mensalidade',
  'Renegociacao com o cliente',
  'Suspensao do servico no periodo',
  'Plano alterado a meio do mes'
];

const CANCEL_REASON_CHIPS_PAID = [
  'Valor cobrado errado - reemissao com o valor correcto',
  'Pagamento duplicado - cobranca registada duas vezes',
  'Servico nao prestado durante o periodo cobrado',
  'Reembolso integral ao cliente',
  'Mes de referencia incorrecto na fatura',
  'Plano errado aplicado na cobranca'
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

type PaymentDetailDialogProps = {
  payment: PaymentRow;
  submitting: boolean;
  actionMode: PaymentActionMode | null;
  showActionForm: boolean;
  payMethod: PaymentMethod;
  payDate: string;
  cancelReason: string;
  previewDoc: { objectUrl: string | null; error: boolean };
  previewDocType: 'invoice' | 'receipt';
  whatsappMessage: string;
  reminderSentToday: boolean;
  onClose: () => void;
  onOpenPdf: (payment: PaymentRow, type: 'invoice' | 'receipt') => void;
  onSendDocumentWhatsapp: (payment: PaymentRow, kind: 'invoice' | 'receipt') => void;
  onOpenPayForm: (payment: PaymentRow) => void;
  onOpenWhatsappForm: (payment: PaymentRow) => void;
  onOpenCancelForm: (payment: PaymentRow) => void;
  onRegenerate: (payment: PaymentRow) => void;
  onCloseActionForm: () => void;
  onPayMethodChange: (method: PaymentMethod) => void;
  onPayDateChange: (date: string) => void;
  onCancelReasonChange: (reason: string) => void;
  onSubmitPay: () => void;
  onSubmitCancel: () => void;
  onSubmitWhatsapp: () => void;
};

export function PaymentDetailDialog({
  payment,
  submitting,
  actionMode,
  showActionForm,
  payMethod,
  payDate,
  cancelReason,
  previewDoc,
  previewDocType,
  whatsappMessage,
  reminderSentToday,
  onClose,
  onOpenPdf,
  onSendDocumentWhatsapp,
  onOpenPayForm,
  onOpenWhatsappForm,
  onOpenCancelForm,
  onRegenerate,
  onCloseActionForm,
  onPayMethodChange,
  onPayDateChange,
  onCancelReasonChange,
  onSubmitPay,
  onSubmitCancel,
  onSubmitWhatsapp
}: PaymentDetailDialogProps) {
  return (
    <Dialog
      open
      size="xl"
      eyebrow="Pre-visualizacao"
      title={payment.clientName}
      onClose={onClose}
      actions={
        <>
          {payment.status !== 'cancelled' && (
            <Button variant="secondary" size="sm" leadingIcon={<FileText size={16} aria-hidden />} onClick={() => onOpenPdf(payment, 'invoice')}>
              Fatura PDF
            </Button>
          )}
          {payment.status !== 'cancelled' && (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<MessageCircle size={16} aria-hidden />}
              disabled={submitting || !normalizeWhatsappPhone(payment.clientPhone)}
              onClick={() => onSendDocumentWhatsapp(payment, payment.status === 'paid' ? 'receipt' : 'invoice')}
            >
              Enviar PDF por WhatsApp
            </Button>
          )}
          {payment.status === 'paid' ? (
            <Button variant="secondary" size="sm" leadingIcon={<ReceiptText size={16} aria-hidden />} onClick={() => onOpenPdf(payment, 'receipt')}>
              Recibo PDF
            </Button>
          ) : payment.status !== 'cancelled' ? (
            <Button variant="secondary" size="sm" leadingIcon={<CheckCircle2 size={16} aria-hidden />} onClick={() => onOpenPayForm(payment)}>
              Registar pagamento
            </Button>
          ) : null}
          {payment.status !== 'cancelled' && normalizeWhatsappPhone(payment.clientPhone) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpenWhatsappForm(payment)}
              disabled={payment.status !== 'paid' && reminderSentToday}
              title={payment.status !== 'paid' && reminderSentToday ? 'Lembrete ja enviado hoje' : 'Enviar WhatsApp'}
            >
              <MessageCircle size={16} aria-hidden />
              {payment.status !== 'paid' && reminderSentToday
                ? 'Enviado hoje'
                : payment.status === 'paid'
                  ? 'Recibo WhatsApp'
                  : 'WhatsApp'}
            </Button>
          )}
          {payment.status !== 'cancelled' && (
            <Button
              variant={payment.status === 'paid' ? 'danger' : 'secondary'}
              size="sm"
              onClick={() => onOpenCancelForm(payment)}
              className={payment.status === 'paid' ? 'danger-ghost' : undefined}
              title={payment.status === 'paid'
                ? 'Anular pagamento ja registado (ex: erro de faturacao)'
                : 'Anular cobranca'}
            >
              <X size={16} aria-hidden />
              {payment.status === 'paid' ? 'Anular pago' : 'Anular'}
            </Button>
          )}
          {payment.canRegenerate === 1 && (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<RotateCcw size={16} aria-hidden />}
              onClick={() => onRegenerate(payment)}
              disabled={submitting}
              title="Criar uma nova fatura com o valor mensal atual do servico"
            >
              {submitting ? 'A regenerar...' : 'Regenerar mensalidade'}
            </Button>
          )}
        </>
      }
    >
      <div className="client-detail payment-preview">
      {showActionForm && actionMode === 'pay' && (
        <form
          className="payment-action-form"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onSubmitPay();
          }}
        >
          <div>
            <p className="eyebrow">Registar pagamento</p>
            <strong>{formatCve(payment.amountCve)}</strong>
          </div>
          <Select label="Metodo" value={payMethod} onChange={(event) => onPayMethodChange(event.target.value as PaymentMethod)} disabled={submitting}>
            <option value="numerario">Numerario</option>
            <option value="transferencia">Transferencia</option>
            <option value="outro">Outro</option>
          </Select>
          <Field label="Data" type="date" value={payDate} onChange={(event) => onPayDateChange(event.target.value)} max={todayIso()} disabled={submitting} required />
          <div className="inline-actions">
            <Button type="submit" disabled={submitting || !payDate}>Confirmar</Button>
            <Button variant="secondary" onClick={onCloseActionForm} disabled={submitting}>Cancelar</Button>
          </div>
        </form>
      )}

      {showActionForm && actionMode === 'cancel' && (() => {
        const wasPaid = payment.status === 'paid';
        const minLen = wasPaid ? 10 : 3;
        return (
          <form
            className={`payment-action-form payment-action-form--cancel${wasPaid ? ' payment-action-form--cancel-paid' : ''}`}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              onSubmitCancel();
            }}
          >
            <div>
              <p className="eyebrow">
                {wasPaid ? 'Anular pagamento ja registado' : 'Anular pagamento'}
              </p>
              {wasPaid ? (
                <small>
                  <strong>Atencao:</strong> anular um pagamento ja registado nao devolve dinheiro.
                  Marca a cobranca <strong>{payment.invoiceNumber || '-'}</strong>
                  {payment.receiptNumber ? ` / ${payment.receiptNumber}` : ''}
                  {' '}como invalida, congela os numeros e regista a anulacao no audit log.
                  Use para corrigir erros de faturacao no valor.
                </small>
              ) : (
                <small>O pagamento e marcado anulado e o motivo fica registado nas notas.</small>
              )}
            </div>
            <div>
              <span className="field-label">Motivo {wasPaid && <em className="payment-form-hint">(minimo 10 caracteres)</em>}</span>
              <div className="reason-chips" role="list" aria-label="Motivos sugeridos">
                {(wasPaid ? CANCEL_REASON_CHIPS_PAID : CANCEL_REASON_CHIPS_PENDING).map((suggestion) => {
                  const active = cancelReason.trim() === suggestion;
                  return (
                    <Button
                      key={suggestion}
                      variant="secondary"
                      size="sm"
                      role="listitem"
                      className={active ? 'reason-chip reason-chip-active' : 'reason-chip'}
                      onClick={() => onCancelReasonChange(suggestion)}
                      disabled={submitting}
                    >
                      {suggestion}
                    </Button>
                  );
                })}
              </div>
              <Textarea
                label="Motivo escrito"
                value={cancelReason}
                onChange={(event) => onCancelReasonChange(event.target.value)}
                rows={wasPaid ? 4 : 3}
                required
                minLength={minLen}
                placeholder={wasPaid
                  ? 'Escolhe um motivo acima ou escreve: ex. valor cobrado 5500 em vez de 4500; cliente notificado.'
                  : 'Escolhe um motivo acima ou escreve livremente.'}
                disabled={submitting}
              />
            </div>
            <div className="inline-actions">
              <Button
                type="submit"
                variant={wasPaid ? 'danger' : 'primary'}
                disabled={submitting || cancelReason.trim().length < minLen}
              >
                {wasPaid ? 'Confirmar anulacao pos-pagamento' : 'Confirmar anulacao'}
              </Button>
              <Button variant="secondary" onClick={onCloseActionForm} disabled={submitting}>Cancelar</Button>
            </div>
          </form>
        );
      })()}

      {showActionForm && actionMode === 'whatsapp' && (
        <form
          className="payment-action-form payment-action-form--whatsapp"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onSubmitWhatsapp();
          }}
        >
          <div>
            <p className="eyebrow">
              {payment.status === 'paid'
                ? 'Recibo WhatsApp'
                : payment.status === 'overdue'
                  ? 'Aviso WhatsApp'
                  : 'Fatura WhatsApp'}
            </p>
            <small>
              Para <strong>{normalizeWhatsappPhone(payment.clientPhone) || '—'}</strong>{' '}
              · template em Configuracoes
            </small>
          </div>
          <Textarea
            label="Mensagem"
            value={whatsappMessage}
            readOnly
            rows={4}
          />
          <div className="inline-actions">
            <Button type="submit" disabled={submitting || !normalizeWhatsappPhone(payment.clientPhone)}>
              {submitting ? 'A enviar...' : 'Enviar'}
            </Button>
            <Button variant="secondary" onClick={onCloseActionForm} disabled={submitting}>Cancelar</Button>
          </div>
        </form>
      )}

      {(() => {
        // A fatura que deu origem ao recibo fica marcada como paga (Badge) e
        // continua acessível via "Fatura PDF".
        const docLabel = previewDocType === 'receipt'
          ? (payment.receiptNumber ? `Recibo ${payment.receiptNumber}` : 'Recibo emitido')
          : (payment.invoiceNumber ? `Fatura ${payment.invoiceNumber}` : 'Fatura por emitir');
        return (
          <>
            <div className="document-preview">
              <span>{docLabel}</span>
              <strong>{formatCve(payment.amountCve)}</strong>
              <small>
                Mes {formatPtMonth(payment.referenceMonth)} - vencimento {formatPtDate(payment.dueDate)} - {payment.status}
              </small>
            </div>
            {payment.status === 'cancelled' ? (
              <Message>Pagamento anulado. Nenhuma fatura ou recibo pode ser emitido.</Message>
            ) : previewDoc.error ? (
              <Message tone="error">Nao foi possivel carregar o documento.</Message>
            ) : previewDoc.objectUrl ? (
              <iframe
                className="payment-pdf-preview"
                title={previewDocType === 'receipt'
                  ? `Pre-visualizacao do recibo ${payment.receiptNumber || payment.id}`
                  : `Pre-visualizacao da fatura ${payment.invoiceNumber || payment.id}`}
                src={previewDoc.objectUrl}
              />
            ) : (
              <Message>A carregar documento…</Message>
            )}
          </>
        );
      })()}
      <dl>
        <div><dt>Mes</dt><dd>{formatPtMonth(payment.referenceMonth)}</dd></div>
        <div><dt>Valor</dt><dd>{formatCve(payment.amountCve)}</dd></div>
        <div><dt>Fatura</dt><dd>{payment.invoiceNumber || '-'}</dd></div>
        <div><dt>Recibo</dt><dd>{payment.receiptNumber || '-'}</dd></div>
        <div><dt>Metodo</dt><dd>{payment.paymentMethod || '-'}</dd></div>
        <div><dt>Data pagamento</dt><dd>{formatPtDate(payment.paymentDate)}</dd></div>
        <div><dt>Estado</dt><dd>{payment.status}</dd></div>
      </dl>
      </div>
    </Dialog>
  );
}
