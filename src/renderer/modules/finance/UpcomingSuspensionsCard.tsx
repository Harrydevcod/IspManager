import { useEffect, useState } from 'react';
import { MessageSquareText, WalletCards } from 'lucide-react';
import { Badge, Button, Card, DataTable, useToast, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve, formatPtDate } from '../../lib/format';
import { useLive } from '../router/useLive';
import { ClientFinanceDialog } from './ClientFinanceDialog';
import { businessDay } from '../../../shared/business-day';
import { SUSPENSION_NOTICE_LEAD_DAYS, type NoticeDelivery, type UpcomingSuspension } from '../../../shared/upcoming-suspension';

const API = 'http://127.0.0.1:3001/api';
export const UPCOMING_SUSPENSIONS_URL = `${API}/finance/upcoming-suspensions`;
const POLL_MS = 5 * 60_000;

type Tone = 'success' | 'warn' | 'danger' | 'neutral';

const SMS_STATUS: Record<string, [string, Tone]> = {
  pending_dispatch: ['Por enviar', 'warn'],
  pending_approval: ['Por aprovar', 'warn'],
  approved: ['Aprovado', 'success'],
  sent: ['Enviado', 'success'],
  failed: ['Falhou', 'danger'],
  rejected: ['Rejeitado', 'danger'],
  cancelled: ['Cancelado', 'neutral']
};

const WHATSAPP_STATUS: Record<string, [string, Tone]> = {
  pending: ['Em fila', 'warn'],
  sent: ['Enviado', 'success'],
  delivered: ['Entregue', 'success'],
  read: ['Lido', 'success'],
  failed: ['Falhou', 'danger'],
  cancelled: ['Cancelado', 'neutral']
};

function DeliveryBadge({ delivery, labels }: { delivery: NoticeDelivery | null; labels: Record<string, [string, Tone]> }) {
  if (!delivery) return <Badge tone="neutral">Nenhum</Badge>;
  const [label, tone] = labels[delivery.status] ?? [delivery.status, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}

function cutLabel(cutDate: string, today: string): string {
  if (cutDate <= today) return 'Hoje';
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return cutDate === tomorrow.toISOString().slice(0, 10) ? 'Amanhã' : formatPtDate(cutDate);
}

/**
 * Quem o corte automático suspende nos próximos dias, para o operador garantir
 * que o cliente foi avisado. Só aparece quando há alguém na lista.
 */
export function UpcomingSuspensionsCard({ onOpenPayment }: { onOpenPayment: (paymentId: number) => void }) {
  const live = useLive<UpcomingSuspension[]>(UPCOMING_SUSPENSIONS_URL, true, POLL_MS);
  const { toast } = useToast();
  const [sending, setSending] = useState<number | null>(null);
  const [financeClientId, setFinanceClientId] = useState<number | null>(null);
  const rows = Array.isArray(live.data) ? live.data : [];
  const today = businessDay();

  async function notifyBySms(row: UpcomingSuspension) {
    setSending(row.paymentId);
    try {
      const response = await authFetch(`${API}/payments/${row.paymentId}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'suspension_notice' })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        toast(body.error || 'Não foi possível pôr o SMS na fila.', 'error');
        return;
      }
      toast(`Aviso de suspensão para ${row.clientName} na fila do telemóvel.`, 'success');
      live.reload();
    } finally {
      setSending(null);
    }
  }

  if (rows.length === 0) return null;

  const columns: DataTableColumn<UpcomingSuspension>[] = [
    { header: 'Código', cell: (row) => <span className="entity-code">{row.clientCode}</span>, sortValue: (row) => row.clientCode },
    { header: 'Cliente', cell: (row) => <strong>{row.clientName}</strong>, sortValue: (row) => row.clientName },
    {
      header: 'Corte',
      cell: (row) => <Badge tone={row.cutDate <= today ? 'danger' : 'warn'}>{cutLabel(row.cutDate, today)}</Badge>,
      sortValue: (row) => row.cutDate
    },
    { header: 'Fatura', cell: (row) => row.invoiceNumber ?? `#${row.paymentId}`, sortValue: (row) => row.invoiceNumber ?? '' },
    { header: 'Em dívida', align: 'end', cell: (row) => formatCve(row.balanceCve), sortValue: (row) => row.balanceCve, defaultDirection: 'desc' },
    { header: 'SMS', cell: (row) => <DeliveryBadge delivery={row.sms} labels={SMS_STATUS} />, sortValue: (row) => row.sms?.status ?? '' },
    { header: 'WhatsApp', cell: (row) => <DeliveryBadge delivery={row.whatsapp} labels={WHATSAPP_STATUS} />, sortValue: (row) => row.whatsapp?.status ?? '' }
  ];

  return (
    <>
      <Card
        eyebrow={`Próximos ${SUSPENSION_NOTICE_LEAD_DAYS} dias · ${rows.length} ${rows.length === 1 ? 'serviço' : 'serviços'}`}
        title="Suspensões a chegar"
        className="upcoming-suspensions-card"
      >
        <DataTable
          rows={rows}
          rowKey={(row) => row.serviceId}
          columns={columns}
          gridTemplateColumns="76px minmax(120px, 1.4fr) 112px minmax(124px, 1fr) 104px 104px 104px"
          actionsWidth="92px"
          defaultSort={{ key: 'Corte', direction: 'asc' }}
          actions={(row) => (
            <>
              <Button
                variant="icon"
                size="sm"
                className="row-action"
                title={row.phone ? 'Avisar por SMS' : 'Sem telefone'}
                aria-label="Avisar por SMS"
                loading={sending === row.paymentId}
                disabled={!row.phone}
                onClick={() => void notifyBySms(row)}
              >
                <MessageSquareText size={14} aria-hidden />
              </Button>
              <Button
                variant="icon"
                size="sm"
                className="row-action"
                title="Ficha financeira"
                aria-label="Ficha financeira"
                onClick={() => setFinanceClientId(row.clientId)}
              >
                <WalletCards size={14} aria-hidden />
              </Button>
            </>
          )}
          empty={null}
        />
      </Card>
      {financeClientId !== null && (
        <ClientFinanceDialog
          key={financeClientId}
          clientId={financeClientId}
          onClose={() => { setFinanceClientId(null); live.reload(); }}
          onOpenInvoice={(paymentId) => { setFinanceClientId(null); onOpenPayment(paymentId); }}
        />
      )}
    </>
  );
}

const NOTIFIED_KEY = 'ispm.upcomingSuspensionsNotifiedOn';
const NOTIFY_CHECK_MS = 60 * 60_000;

/**
 * Notificação do Windows uma vez por dia quando há suspensões a chegar, esteja o
 * operador em que ecrã estiver. Clicar traz a janela e abre o Painel.
 */
export function useUpcomingSuspensionsNotice(enabled: boolean, onOpen: () => void) {
  useEffect(() => {
    if (!enabled || typeof Notification === 'undefined') return;
    let alive = true;
    const check = async () => {
      const today = businessDay();
      try {
        if (localStorage.getItem(NOTIFIED_KEY) === today) return;
      } catch { /* sem armazenamento: notifica na mesma */ }
      const response = await authFetch(UPCOMING_SUSPENSIONS_URL).catch(() => null);
      if (!alive || !response?.ok) return;
      const rows = await response.json().catch(() => []) as UpcomingSuspension[];
      if (!Array.isArray(rows) || rows.length === 0) return;
      const first = rows[0];
      const notice = new Notification(
        rows.length === 1 ? '1 suspensão nos próximos 7 dias' : `${rows.length} suspensões nos próximos 7 dias`,
        { body: `${first.clientName}: corte ${cutLabel(first.cutDate, today).toLowerCase()}${rows.length > 1 ? ` e mais ${rows.length - 1}` : ''}.` }
      );
      notice.onclick = () => { window.focus(); onOpen(); };
      try { localStorage.setItem(NOTIFIED_KEY, today); } catch { /* idem */ }
    };
    void check();
    const id = window.setInterval(() => void check(), NOTIFY_CHECK_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [enabled, onOpen]);
}
