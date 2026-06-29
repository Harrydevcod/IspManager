import { AlertTriangle, CheckCircle2, Eye, FileText, MessageCircle, ReceiptText, RotateCcw, Send, Smartphone, Undo2, X } from 'lucide-react';
import { Badge, Button, DataTable, EmptyState } from '../../components';
import { formatCve, formatPtDate, formatPtMonth } from '../../lib/format';
import type { SortState } from '../../lib/listView';
import { normalizeWhatsappPhone } from '../../lib/whatsapp';
import type { PaymentRow, SmsEventType } from '../../types';

type PaymentSortKey = 'dueDate' | 'clientName' | 'status' | 'amountCve';

const paymentStatusTone = (status: PaymentRow['status']): 'success' | 'info' | 'danger' | 'neutral' => {
  switch (status) {
    case 'paid': return 'success';
    case 'pending': return 'info';
    case 'overdue': return 'danger';
    case 'cancelled': return 'neutral';
  }
};

const statusLabel = (status: PaymentRow['status']): string => status;

type PaymentsListProps = {
  payments: PaymentRow[];
  activeId: number | null;
  sort: SortState<PaymentSortKey>;
  onSortChange: (sort: SortState<PaymentSortKey>) => void;
  submitting: boolean;
  isReminderSentToday: (paymentId: number) => boolean;
  onPreview: (payment: PaymentRow) => void;
  onOpenPdf: (payment: PaymentRow, type: 'invoice' | 'receipt') => void;
  onMarkOverdue: (payment: PaymentRow) => void;
  onOpenPayForm: (payment: PaymentRow) => void;
  onOpenWhatsappForm: (payment: PaymentRow) => void;
  onSendDocumentWhatsapp: (payment: PaymentRow, kind: 'invoice' | 'receipt') => void;
  onSendSms: (payment: PaymentRow, eventType: SmsEventType) => void;
  onOpenCancelForm: (payment: PaymentRow) => void;
  onRevert: (payment: PaymentRow) => void;
  onRegenerate: (payment: PaymentRow) => void;
};

export function PaymentsList({
  payments,
  activeId,
  sort,
  onSortChange,
  submitting,
  isReminderSentToday,
  onPreview,
  onOpenPdf,
  onMarkOverdue,
  onOpenPayForm,
  onOpenWhatsappForm,
  onSendDocumentWhatsapp,
  onSendSms,
  onOpenCancelForm,
  onRevert,
  onRegenerate
}: PaymentsListProps) {
  return (
    <DataTable
      rows={payments}
      rowKey={(p) => p.id}
      activeKey={activeId}
      stickyHeader
      sort={sort}
      onSortChange={onSortChange}
      onRowClick={(p) => onPreview(p)}
      gridTemplateColumns="minmax(220px, 1.6fr) 132px 108px 132px"
      actionsWidth="minmax(292px, max-content)"
      columns={[
        {
          header: 'Cliente',
          sortKey: 'clientName',
          cell: (p) => (
            <span>
              <small className="entity-code">{p.clientCode || '—'}</small>
              <strong>{p.clientName}</strong>
              <small>{formatPtMonth(p.referenceMonth)} · FT {p.invoiceNumber || '-'}</small>
            </span>
          )
        },
        {
          header: 'Vencimento',
          sortKey: 'dueDate',
          cell: (p) => <span>{formatPtDate(p.dueDate)}</span>
        },
        {
          header: 'Estado',
          sortKey: 'status',
          align: 'center',
          cell: (p) => <Badge tone={paymentStatusTone(p.status)}>{statusLabel(p.status)}</Badge>
        },
        {
          header: 'Valor',
          sortKey: 'amountCve',
          defaultDirection: 'desc',
          align: 'end',
          cell: (p) => <b>{formatCve(p.amountCve)}</b>
        }
      ]}
      actions={(p) => (
        <>
          <Button variant="icon" size="sm" title="Pre-visualizar" onClick={() => onPreview(p)}>
            <Eye size={16} aria-hidden />
          </Button>
          {p.status !== 'cancelled' && (
            <Button variant="icon" size="sm" title="Fatura PDF" onClick={() => onOpenPdf(p, 'invoice')}>
              <FileText size={16} aria-hidden />
            </Button>
          )}
          {p.status === 'pending' && (
            <Button variant="icon" size="sm" title="Marcar atraso" onClick={() => onMarkOverdue(p)}>
              <AlertTriangle size={16} aria-hidden />
            </Button>
          )}
          {p.status === 'paid' ? (
            <Button variant="icon" size="sm" title="Recibo PDF" onClick={() => onOpenPdf(p, 'receipt')}>
              <ReceiptText size={16} aria-hidden />
            </Button>
          ) : p.status !== 'cancelled' ? (
            <Button variant="icon" size="sm" title="Registar pagamento" onClick={() => onOpenPayForm(p)}>
              <CheckCircle2 size={16} aria-hidden />
            </Button>
          ) : null}
          {p.status !== 'paid' && p.status !== 'cancelled' && normalizeWhatsappPhone(p.clientPhone) && (
            <Button
              variant="icon"
              size="sm"
              title={isReminderSentToday(p.id) ? 'Lembrete WhatsApp ja enviado hoje' : 'Lembrete WhatsApp'}
              onClick={() => onOpenWhatsappForm(p)}
              disabled={isReminderSentToday(p.id)}
            >
              <MessageCircle size={16} aria-hidden />
            </Button>
          )}
          {p.status !== 'cancelled' && normalizeWhatsappPhone(p.clientPhone) && (
            <Button
              variant="icon"
              size="sm"
              title={p.status === 'paid' ? 'Enviar recibo (PDF) por WhatsApp' : 'Enviar fatura (PDF) por WhatsApp'}
              disabled={submitting}
              onClick={() => onSendDocumentWhatsapp(p, p.status === 'paid' ? 'receipt' : 'invoice')}
            >
              <Send size={16} aria-hidden />
            </Button>
          )}
          {p.status !== 'cancelled' && normalizeWhatsappPhone(p.clientPhone) && (
            <Button
              variant="icon"
              size="sm"
              title={p.status === 'paid' ? 'Enviar recibo por SMS (Android)' : p.status === 'overdue' ? 'Enviar aviso de atraso por SMS (Android)' : 'Enviar fatura por SMS (Android)'}
              disabled={submitting}
              onClick={() => onSendSms(p, p.status === 'paid' ? 'receipt_confirmed' : p.status === 'overdue' ? 'payment_overdue' : 'invoice_issued')}
            >
              <Smartphone size={16} aria-hidden />
            </Button>
          )}
          {p.status !== 'cancelled' && (
            <Button
              variant="icon"
              size="sm"
              title={p.status === 'paid'
                ? 'Anular pagamento ja registado (erro de faturacao)'
                : 'Anular cobranca'}
              onClick={() => onOpenCancelForm(p)}
              className={p.status === 'paid' ? 'danger-ghost' : undefined}
            >
              <X size={16} aria-hidden />
            </Button>
          )}
          {(p.status === 'pending' || p.status === 'overdue') && (
            <Button
              variant="icon"
              size="sm"
              title="Reverter geracao (apaga a cobranca)"
              onClick={() => onRevert(p)}
            >
              <Undo2 size={16} aria-hidden />
            </Button>
          )}
          {p.canRegenerate === 1 && (
            <Button
              variant="icon"
              size="sm"
              title="Regenerar mensalidade com o valor atual do servico"
              onClick={() => onRegenerate(p)}
              disabled={submitting}
            >
              <RotateCcw size={16} aria-hidden />
            </Button>
          )}
        </>
      )}
      empty={
        <EmptyState
          icon={ReceiptText}
          title="Nenhuma cobrança encontrada"
          description="Ajusta os filtros ou aguarda novos serviços para gerar cobranças."
        />
      }
    />
  );
}
