import { AlertTriangle, CheckCircle2, FileText, MessageCircle, ReceiptText, RotateCcw, Send, Smartphone, Undo2, X } from 'lucide-react';
import { Badge, DataTable, EmptyState, RowActionsMenu, type DataTableSelection, type RowActionGroup } from '../../components';
import { formatCve, formatPtDate, formatPtMonth } from '../../lib/format';
import type { SortState } from '../../lib/listView';
import { effectivePaymentStatus } from '../../lib/status';
import { normalizeWhatsappPhone } from '../../lib/whatsapp';
import { paymentStatusLabel, type PaymentRow, type SmsEventType } from '../../types';

type PaymentSortKey = 'dueDate' | 'clientName' | 'status' | 'amountCve';

const paymentStatusTone = (status: PaymentRow['status']): 'success' | 'info' | 'danger' | 'neutral' => {
  switch (status) {
    case 'paid': return 'success';
    case 'pending': return 'info';
    case 'overdue': return 'danger';
    case 'cancelled': return 'neutral';
  }
};


type PaymentsListProps = {
  payments: PaymentRow[];
  activeId: number | null;
  selection?: DataTableSelection;
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
  selection,
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
      selection={selection}
      stickyHeader
      sort={sort}
      onSortChange={onSortChange}
      onRowClick={(p) => onPreview(p)}
      gridTemplateColumns="minmax(200px, 1fr) 116px 100px 128px"
      actionsWidth="104px"
      columns={[
        {
          header: 'Cliente',
          sortKey: 'clientName',
          cell: (p) => (
            <span>
              <small className="entity-code">{p.clientCode || '—'}</small>
              <strong>{p.clientName}</strong>
              <small>{formatPtMonth(p.referenceMonth)} · {p.invoiceNumber || 'sem fatura'}</small>
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
          // A etiqueta segue o estado efetivo: um pendente com a data passada
          // lê-se "Em atraso", senão o filtro devolvia linhas a dizer Pendente.
          cell: (p) => {
            const status = effectivePaymentStatus(p);
            return <Badge tone={paymentStatusTone(status)}>{paymentStatusLabel(status)}</Badge>;
          }
        },
        {
          header: 'Valor',
          sortKey: 'amountCve',
          defaultDirection: 'desc',
          align: 'end',
          cell: (p) => <b>{formatCve(p.amountCve)}</b>
        }
      ]}
      actions={(p) => {
        if (p.status === 'cancelled') return null;
        const hasPhone = Boolean(normalizeWhatsappPhone(p.clientPhone));
        // O aviso segue o estado efetivo; as ações de gestão ("Marcar atraso",
        // "Reverter") continuam a olhar para p.status, que é o que gravam.
        const effective = effectivePaymentStatus(p);
        const smsEvent: SmsEventType = effective === 'paid'
          ? 'receipt_confirmed'
          : effective === 'overdue' ? 'payment_overdue' : 'invoice_issued';

        const acao: RowActionGroup = {
          label: 'Ação',
          items: p.status === 'paid'
            ? [{ label: 'Recibo PDF', icon: <ReceiptText size={15} aria-hidden />, onClick: () => onOpenPdf(p, 'receipt') }]
            : [
                { label: 'Registar pagamento', icon: <CheckCircle2 size={15} aria-hidden />, onClick: () => onOpenPayForm(p) },
                ...(hasPhone
                  ? [{
                      label: 'Lembrete WhatsApp',
                      icon: <MessageCircle size={15} aria-hidden />,
                      onClick: () => onOpenWhatsappForm(p),
                      disabled: isReminderSentToday(p.id),
                      title: isReminderSentToday(p.id) ? 'Lembrete WhatsApp ja enviado hoje' : undefined
                    }]
                  : [])
              ]
        };

        const documentos: RowActionGroup = {
          label: 'Documentos',
          items: [
            { label: 'Fatura PDF', icon: <FileText size={15} aria-hidden />, onClick: () => onOpenPdf(p, 'invoice') }
          ]
        };
        const comunicacao: RowActionGroup = {
          label: 'Comunicação',
          items: hasPhone
            ? [
                {
                  label: p.status === 'paid' ? 'Enviar recibo por WhatsApp' : 'Enviar fatura por WhatsApp',
                  icon: <Send size={15} aria-hidden />,
                  onClick: () => onSendDocumentWhatsapp(p, p.status === 'paid' ? 'receipt' : 'invoice'),
                  disabled: submitting
                },
                {
                  label: effective === 'paid'
                    ? 'Enviar recibo por SMS (Android)'
                    : effective === 'overdue' ? 'Enviar aviso por SMS (Android)' : 'Enviar fatura por SMS (Android)',
                  icon: <Smartphone size={15} aria-hidden />,
                  onClick: () => onSendSms(p, smsEvent),
                  disabled: submitting
                },
                ...(p.status === 'paid'
                  ? [{ label: 'Recibo por WhatsApp', icon: <MessageCircle size={15} aria-hidden />, onClick: () => onOpenWhatsappForm(p) }]
                  : [])
              ]
            : []
        };
        const gestao: RowActionGroup = {
          label: 'Gestão',
          items: [
            ...(p.status === 'pending'
              ? [{ label: 'Marcar atraso', icon: <AlertTriangle size={15} aria-hidden />, onClick: () => onMarkOverdue(p) }]
              : []),
            {
              label: p.status === 'paid' ? 'Anular pagamento' : 'Anular cobrança',
              icon: <X size={15} aria-hidden />,
              onClick: () => onOpenCancelForm(p),
              danger: true
            },
            ...(p.status === 'pending' || p.status === 'overdue'
              ? [{ label: 'Reverter geração', icon: <Undo2 size={15} aria-hidden />, onClick: () => onRevert(p) }]
              : []),
            ...(p.canRegenerate === 1
              ? [{ label: 'Regenerar mensalidade', icon: <RotateCcw size={15} aria-hidden />, onClick: () => onRegenerate(p), disabled: submitting }]
              : [])
          ]
        };

        return <RowActionsMenu groups={[acao, documentos, comunicacao, gestao]} />;
      }}
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
