import { AlertTriangle, CheckCircle2, FileText, MessageCircle, ReceiptText, RotateCcw, Send, Smartphone, Undo2, X } from 'lucide-react';
import { Badge, DataTable, EmptyState, RowActionsMenu, type DataTableSelection, type RowActionGroup } from '../../components';
import type { DataTableColumn } from '../../components/DataTable';
import { formatCve, formatPtDate, formatPtMonth } from '../../lib/format';
import type { SortState } from '../../lib/listView';
import { effectivePaymentStatus } from '../../lib/status';
import { normalizeWhatsappPhone } from '../../lib/whatsapp';
import { paymentStatusLabel, type EffectivePaymentStatus, type PaymentRow, type SmsEventType } from '../../types';

const paymentStatusTone = (status: EffectivePaymentStatus): 'success' | 'info' | 'danger' | 'neutral' | 'warn' => {
  switch (status) {
    case 'paid': return 'success';
    case 'pending': return 'info';
    case 'partial': return 'warn';
    case 'overdue': return 'danger';
    case 'cancelled': return 'neutral';
  }
};
const isPartial = (p: PaymentRow) => p.receivedCve > 0 && p.balanceCve > 0;

/**
 * Exportadas porque a lista é paginada: o `PaymentsModule` ordena com estas
 * colunas antes de cortar a página.
 */
export const PAYMENT_COLUMNS: DataTableColumn<PaymentRow>[] = [
  { header: 'Código', sortValue: (p) => p.clientCode, cell: (p) => <span className="entity-code">{p.clientCode || '—'}</span> },
  { header: 'Cliente', sortValue: (p) => p.clientName, cell: (p) => <strong>{p.clientName}</strong> },
  // 'INSTALACAO' não é um mês e mostra "-": ordena como vazio, no fim.
  { header: 'Referência', sortValue: (p) => (/^\d{4}-\d{2}$/.test(p.referenceMonth) ? p.referenceMonth : null), defaultDirection: 'desc', cell: (p) => <span>{formatPtMonth(p.referenceMonth)}</span> },
  { header: 'Fatura', sortValue: (p) => p.invoiceNumber, cell: (p) => <span>{p.invoiceNumber || '—'}</span> },
  {
    header: 'Vencimento',
    sortValue: (p) => p.dueDate,
    cell: (p) => <span>{formatPtDate(p.dueDate)}</span>
  },
  {
    header: 'Estado',
    align: 'center',
    // A etiqueta segue o estado efetivo: um pendente com a data passada
    // lê-se "Em atraso", senão o filtro devolvia linhas a dizer Pendente.
    sortValue: (p) => paymentStatusLabel(effectivePaymentStatus(p)),
    cell: (p) => {
      const status = effectivePaymentStatus(p);
      return <Badge tone={paymentStatusTone(status)}>{paymentStatusLabel(status)}</Badge>;
    }
  },
  {
    header: 'Recebido',
    align: 'end',
    // Só o meio pago tem recebido a mostrar: pago por inteiro lê-se no
    // Estado, e repetir o valor aqui seria ruído.
    sortValue: (p) => (isPartial(p) ? p.receivedCve : null),
    defaultDirection: 'desc',
    cell: (p) => <span>{isPartial(p) ? formatCve(p.receivedCve) : '—'}</span>
  },
  {
    header: 'Valor',
    defaultDirection: 'desc',
    align: 'end',
    // Meio pago mostra o que falta, porque é isso que se cobra; o total
    // fica no title para a conta fechar a olho. Ordena pelo que se vê.
    sortValue: (p) => (isPartial(p) ? p.balanceCve : p.amountCve),
    cell: (p) => (isPartial(p)
      ? <b title={`Em falta de ${formatCve(p.amountCve)}`}>{formatCve(p.balanceCve)}</b>
      : <b>{formatCve(p.amountCve)}</b>)
  }
];

type PaymentsListProps = {
  payments: PaymentRow[];
  activeId: number | null;
  selection?: DataTableSelection;
  sort: SortState<string>;
  onSortChange: (sort: SortState<string>) => void;
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
      gridTemplateColumns="80px minmax(160px, 1.5fr) 104px minmax(96px, 0.8fr) 108px 110px 116px 120px"
      actionsWidth="104px"
      columns={PAYMENT_COLUMNS}
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
