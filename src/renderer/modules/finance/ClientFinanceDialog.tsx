import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CalendarClock, Handshake, PiggyBank, Wallet } from 'lucide-react';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  ErrorRetry,
  Field,
  MetricCard,
  MetricGrid,
  Select,
  SkeletonList,
  TabList,
  Textarea,
  useToast
} from '../../components';
import type { DataTableColumn, DataTableSelection } from '../../components/DataTable';
import { authFetch } from '../../lib/auth';
import { formatCve, formatPtDate, formatPtDateTime, formatPtMonth } from '../../lib/format';
import { businessDay } from '../../../shared/business-day';
import { MAX_INSTALLMENTS, MIN_INSTALLMENTS, monthlyDueDates, splitInstallments } from '../../../shared/payment-plan';
import { METHOD_LABELS } from '../payments/ReceiptsSection';
import {
  AGING_LABELS,
  type ClientFinance,
  type ClientFinanceInvoice,
  type InstallmentStatus,
  type PaymentPlan,
  type PaymentPlanStatus
} from '../../types';

const API = 'http://127.0.0.1:3001/api';

type Tab = 'faturas' | 'pagamentos' | 'avisos' | 'acordo';
type Tone = 'success' | 'info' | 'warn' | 'danger' | 'neutral';

type Receipt = ClientFinance['receipts'][number];
type Notice = ClientFinance['notices'][number];
type Installment = PaymentPlan['installments'][number];

const PLAN_STATUS: Record<PaymentPlanStatus, { label: string; tone: Tone }> = {
  em_dia: { label: 'Acordo em dia', tone: 'success' },
  em_atraso: { label: 'Acordo em atraso', tone: 'danger' },
  cumprido: { label: 'Acordo cumprido', tone: 'info' },
  cancelado: { label: 'Acordo cancelado', tone: 'neutral' }
};

const INSTALLMENT_STATUS: Record<InstallmentStatus, { label: string; tone: Tone }> = {
  paga: { label: 'Paga', tone: 'success' },
  por_pagar: { label: 'Por pagar', tone: 'neutral' },
  em_atraso: { label: 'Em atraso', tone: 'danger' }
};

const NOTICE_KIND: Record<string, string> = {
  reminder: 'Lembrete',
  overdue: 'Em atraso',
  warning: 'Aviso',
  suspension: 'Aviso de corte',
  invoice_issued: 'Fatura emitida',
  receipt_confirmed: 'Recibo',
  payment_overdue: 'Em atraso',
  suspension_notice: 'Aviso de corte',
  fup_notice: 'Uso justo'
};

const NOTICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  sent: { label: 'Enviado', tone: 'success' },
  delivered: { label: 'Entregue', tone: 'success' },
  queued: { label: 'Na fila', tone: 'info' },
  pending: { label: 'Na fila', tone: 'info' },
  pending_dispatch: { label: 'Na fila', tone: 'info' },
  pending_approval: { label: 'Por aprovar', tone: 'warn' },
  approved: { label: 'Aprovado', tone: 'info' },
  failed: { label: 'Falhou', tone: 'danger' },
  rejected: { label: 'Rejeitado', tone: 'danger' },
  cancelled: { label: 'Cancelado', tone: 'neutral' }
};

const BUCKET_TONE: Record<ClientFinanceInvoice['bucket'], Tone> = {
  current: 'info',
  d30: 'warn',
  d60: 'warn',
  d90: 'danger',
  d90plus: 'danger'
};

const invoiceLabel = (invoiceNumber: string | null, referenceMonth: string | null) =>
  invoiceNumber || (referenceMonth ? formatPtMonth(referenceMonth) : '—');

const INVOICE_COLUMNS: DataTableColumn<ClientFinanceInvoice>[] = [
  { header: 'Fatura', sortValue: (i) => i.invoiceNumber, cell: (i) => <span className="entity-code">{i.invoiceNumber || '—'}</span> },
  { header: 'Mês', sortValue: (i) => i.referenceMonth, cell: (i) => <span>{formatPtMonth(i.referenceMonth)}</span> },
  { header: 'Vencimento', sortValue: (i) => i.dueDate, cell: (i) => <span>{formatPtDate(i.dueDate)}</span> },
  {
    header: 'Atraso',
    align: 'center',
    sortValue: (i) => i.daysOverdue,
    defaultDirection: 'desc',
    cell: (i) => <Badge tone={BUCKET_TONE[i.bucket]}>{i.isOverdue ? `${i.daysOverdue} d` : AGING_LABELS[i.bucket]}</Badge>
  },
  { header: 'Valor', align: 'end', sortValue: (i) => i.amountCve, cell: (i) => <span>{formatCve(i.amountCve)}</span> },
  { header: 'Recebido', align: 'end', sortValue: (i) => i.receivedCve, cell: (i) => <span>{i.receivedCve > 0 ? formatCve(i.receivedCve) : '—'}</span> },
  { header: 'Em aberto', align: 'end', sortValue: (i) => i.balanceCve, defaultDirection: 'desc', cell: (i) => <b>{formatCve(i.balanceCve)}</b> },
  {
    header: 'Acordo',
    align: 'center',
    sortValue: (i) => i.planId,
    cell: (i) => (i.planId ? <Badge tone="info">Acordo</Badge> : <span>—</span>)
  }
];

/** Escolha das faturas a renegociar: só o que identifica a fatura e o saldo que entra no acordo. */
const PICK_COLUMNS = INVOICE_COLUMNS.filter((c) => ['Fatura', 'Mês', 'Vencimento', 'Em aberto'].includes(c.header));

const RECEIPT_COLUMNS: DataTableColumn<Receipt>[] = [
  { header: 'Data', sortValue: (r) => r.paymentDate, cell: (r) => <span>{formatPtDate(r.paymentDate)}</span> },
  { header: 'Recibo', sortValue: (r) => r.receiptNumber, cell: (r) => <span className="entity-code">{r.receiptNumber}</span> },
  { header: 'Fatura', sortValue: (r) => r.invoiceNumber, cell: (r) => <span>{invoiceLabel(r.invoiceNumber, r.referenceMonth)}</span> },
  {
    header: 'Via',
    sortValue: (r) => (r.source === 'credit' ? 'Crédito' : METHOD_LABELS[r.paymentMethod] || r.paymentMethod),
    cell: (r) => <span>{r.source === 'credit' ? 'Crédito' : METHOD_LABELS[r.paymentMethod] || r.paymentMethod}</span>
  },
  {
    header: 'Valor',
    align: 'end',
    sortValue: (r) => r.amountCve,
    cell: (r) => (r.voidedAt ? <s>{formatCve(r.amountCve)}</s> : <b>{formatCve(r.amountCve)}</b>)
  },
  {
    header: 'Estado',
    align: 'center',
    sortValue: (r) => (r.voidedAt ? 1 : 0),
    cell: (r) => (r.voidedAt ? <Badge tone="danger">Anulado</Badge> : <Badge tone="success">Válido</Badge>)
  }
];

const NOTICE_COLUMNS: DataTableColumn<Notice>[] = [
  { header: 'Data', sortValue: (n) => n.at, cell: (n) => <span>{formatPtDateTime(n.at)}</span> },
  { header: 'Canal', sortValue: (n) => n.channel, cell: (n) => <span>{n.channel === 'sms' ? 'SMS' : 'WhatsApp'}</span> },
  { header: 'Tipo', sortValue: (n) => NOTICE_KIND[n.kind] || n.kind, cell: (n) => <span>{NOTICE_KIND[n.kind] || n.kind}</span> },
  { header: 'Origem', sortValue: (n) => n.origin, cell: (n) => <span>{n.origin === 'manual' ? 'Manual' : 'Automático'}</span> },
  { header: 'Fatura', sortValue: (n) => n.invoiceNumber, cell: (n) => <span>{invoiceLabel(n.invoiceNumber, n.referenceMonth)}</span> },
  {
    header: 'Estado',
    align: 'center',
    sortValue: (n) => n.status,
    cell: (n) => {
      const status = NOTICE_STATUS[n.status] || { label: n.status, tone: 'neutral' as Tone };
      return <Badge tone={status.tone}>{status.label}</Badge>;
    }
  }
];

const INSTALLMENT_COLUMNS: DataTableColumn<Installment>[] = [
  { header: 'Nº', align: 'center', sortValue: (i) => i.seq, cell: (i) => <span>{i.seq}</span> },
  { header: 'Vencimento', sortValue: (i) => i.dueDate, cell: (i) => <span>{formatPtDate(i.dueDate)}</span> },
  { header: 'Valor', align: 'end', sortValue: (i) => i.amountCve, cell: (i) => <b>{formatCve(i.amountCve)}</b> },
  {
    header: 'Estado',
    align: 'center',
    sortValue: (i) => i.status,
    cell: (i) => <Badge tone={INSTALLMENT_STATUS[i.status].tone}>{INSTALLMENT_STATUS[i.status].label}</Badge>
  }
];

type ClientFinanceDialogProps = {
  clientId: number;
  onClose: () => void;
  /** Abre a fatura em Pagamentos, onde se regista o recebimento. */
  onOpenInvoice: (paymentId: number) => void;
  onOpenClient?: (clientId: number) => void;
};

export function ClientFinanceDialog({ clientId, onClose, onOpenInvoice, onOpenClient }: ClientFinanceDialogProps) {
  const [finance, setFinance] = useState<ClientFinance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('faturas');

  const load = useCallback(async () => {
    try {
      const response = await authFetch(`${API}/clients/${clientId}/finance`);
      if (!response.ok) {
        setLoadError('Não foi possível carregar a ficha financeira.');
        return;
      }
      setFinance(await response.json() as ClientFinance);
      setLoadError(null);
    } catch {
      setLoadError('Não foi possível carregar a ficha financeira.');
    }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);

  const activePlan = finance?.plans.find((p) => p.status === 'em_dia' || p.status === 'em_atraso') ?? null;
  const summary = finance?.summary;

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      eyebrow="Ficha financeira"
      title={finance?.client.name ?? 'Cliente'}
      actions={
        <>
          {onOpenClient && (
            <Button variant="secondary" onClick={() => onOpenClient(clientId)}>Abrir ficha do cliente</Button>
          )}
          <Button variant="ghost" onClick={onClose}>Fechar</Button>
        </>
      }
    >
      {loadError && !finance ? (
        <ErrorRetry message={loadError} onRetry={() => { void load(); }} />
      ) : !finance || !summary ? (
        <SkeletonList rows={5} />
      ) : (
        <div className="client-finance">
          <div className="client-finance-meta">
            {finance.client.code && <span className="entity-code">{finance.client.code}</span>}
            {finance.client.phone && <span>{finance.client.phone}</span>}
            {finance.client.zone && <span>{finance.client.zone}</span>}
            {activePlan && <Badge tone={PLAN_STATUS[activePlan.status].tone}>{PLAN_STATUS[activePlan.status].label}</Badge>}
          </div>

          <MetricGrid label="Situação financeira">
            <MetricCard
              icon={Wallet}
              label="Em dívida"
              value={formatCve(summary.openCve)}
              trend={`vencido ${formatCve(summary.overdueCve)}`}
              tone={summary.overdueCve > 0 ? 'danger' : 'neutral'}
            />
            <MetricCard
              icon={AlertTriangle}
              label="Faturas em atraso"
              value={String(summary.overdueInvoices)}
              trend={summary.maxDaysOverdue > 0 ? `a mais antiga há ${summary.maxDaysOverdue} dias` : 'nenhuma vencida'}
              tone={summary.overdueInvoices > 0 ? 'warning' : 'neutral'}
            />
            <MetricCard
              icon={PiggyBank}
              label="Crédito"
              value={formatCve(summary.creditCve)}
              trend="a favor do cliente"
              tone={summary.creditCve > 0 ? 'info' : 'neutral'}
            />
            <MetricCard
              icon={CalendarClock}
              label="Último pagamento"
              value={summary.lastPaymentCve === null ? '—' : formatCve(summary.lastPaymentCve)}
              trend={summary.lastPaymentDate ? formatPtDate(summary.lastPaymentDate) : 'sem pagamentos'}
              tone="revenue"
            />
          </MetricGrid>

          <TabList
            segmented
            idPrefix="client-finance"
            label="Ficha financeira"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'faturas', label: `Faturas em aberto (${finance.invoices.length})` },
              { id: 'pagamentos', label: `Pagamentos (${finance.receipts.length})` },
              { id: 'avisos', label: `Avisos (${finance.notices.length})` },
              { id: 'acordo', label: 'Acordo de pagamento' }
            ]}
          />

          <div className="tab-panel" role="tabpanel" id={`client-finance-panel-${tab}`} aria-labelledby={`client-finance-tab-${tab}`}>
            {tab === 'faturas' && (
              <DataTable<ClientFinanceInvoice>
                rows={finance.invoices}
                rowKey={(i) => i.paymentId}
                columns={INVOICE_COLUMNS}
                defaultSort={{ key: 'Vencimento', direction: 'asc' }}
                onRowClick={(i) => onOpenInvoice(i.paymentId)}
                gridTemplateColumns="minmax(112px, 1fr) 96px 104px 112px 104px 104px 112px 88px"
                empty={<EmptyState size="sm" icon={Wallet} title="Sem dívida em aberto" />}
              />
            )}
            {tab === 'pagamentos' && (
              <DataTable<Receipt>
                rows={finance.receipts}
                rowKey={(r) => r.id}
                columns={RECEIPT_COLUMNS}
                defaultSort={{ key: 'Data', direction: 'desc' }}
                onRowClick={(r) => onOpenInvoice(r.paymentId)}
                gridTemplateColumns="104px minmax(112px, 1fr) minmax(112px, 1fr) 112px 112px 96px"
                empty={<EmptyState size="sm" icon={CalendarClock} title="Sem pagamentos registados" />}
              />
            )}
            {tab === 'avisos' && (
              <DataTable<Notice>
                rows={finance.notices}
                rowKey={(n) => `${n.channel}-${n.id}`}
                columns={NOTICE_COLUMNS}
                defaultSort={{ key: 'Data', direction: 'desc' }}
                gridTemplateColumns="144px 96px minmax(104px, 1fr) 104px minmax(104px, 1fr) 112px"
                empty={<EmptyState size="sm" icon={AlertTriangle} title="Nenhum aviso enviado" />}
              />
            )}
            {tab === 'acordo' && (
              <PaymentPlanPanel finance={finance} activePlan={activePlan} onChanged={load} />
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function PaymentPlanPanel({ finance, activePlan, onChanged }: {
  finance: ClientFinance;
  activePlan: PaymentPlan | null;
  onChanged: () => Promise<void>;
}) {
  const history = finance.plans.filter((p) => p !== activePlan);
  return (
    <div className="client-finance-plan">
      {activePlan
        ? <ActivePlan plan={activePlan} onChanged={onChanged} />
        : <NewPlanForm finance={finance} onChanged={onChanged} />}
      {history.length > 0 && (
        <section className="client-finance-plan-history" aria-label="Acordos anteriores">
          <h3>Acordos anteriores</h3>
          <ul>
            {history.map((plan) => (
              <li key={plan.id}>
                <span>{formatPtDate(plan.createdAt)}</span>
                <span>{plan.installments.length} prestações</span>
                <b>{formatCve(plan.totalCve)}</b>
                <Badge tone={PLAN_STATUS[plan.status].tone}>{PLAN_STATUS[plan.status].label}</Badge>
                {plan.cancelReason && <small title={plan.cancelReason}>{plan.cancelReason}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActivePlan({ plan, onChanged }: { plan: PaymentPlan; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const progress = plan.totalCve > 0 ? Math.min(100, (plan.paidCve / plan.totalCve) * 100) : 0;

  async function cancel(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await authFetch(`${API}/payment-plans/${plan.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        toast(body.error || 'Não foi possível cancelar o acordo.', 'error');
        return;
      }
      toast('Acordo cancelado.', 'success');
      await onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="client-finance-plan-head">
        <div>
          <span>Total</span>
          <b>{formatCve(plan.totalCve)}</b>
        </div>
        <div>
          <span>Pago</span>
          <b>{formatCve(plan.paidCve)}</b>
        </div>
        <div>
          <span>Em falta</span>
          <b>{formatCve(plan.remainingCve)}</b>
        </div>
        <div>
          <span>Em atraso</span>
          <b className={plan.arrearsCve > 0 ? 'is-danger' : undefined}>{formatCve(plan.arrearsCve)}</b>
        </div>
        <Badge tone={PLAN_STATUS[plan.status].tone}>{PLAN_STATUS[plan.status].label}</Badge>
      </div>
      <div
        className="client-finance-progress"
        role="progressbar"
        aria-label="Pago do acordo"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <p className="client-finance-plan-invoices">
        {plan.invoices.map((i) => invoiceLabel(i.invoiceNumber, i.referenceMonth)).join(' · ')}
        {plan.notes && <> — {plan.notes}</>}
      </p>
      <DataTable<Installment>
        rows={plan.installments}
        rowKey={(i) => i.seq}
        columns={INSTALLMENT_COLUMNS}
        defaultSort={{ key: 'Nº', direction: 'asc' }}
        gridTemplateColumns="56px 120px 128px 112px"
        empty={null}
      />
      <form className="client-finance-plan-cancel" onSubmit={cancel}>
        <Field
          label="Motivo do cancelamento"
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button type="submit" variant="critical" loading={submitting} disabled={!reason.trim()}>
          Cancelar acordo
        </Button>
      </form>
    </>
  );
}

function NewPlanForm({ finance, onChanged }: { finance: ClientFinance; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const eligible = useMemo(() => finance.invoices.filter((i) => !i.planId), [finance.invoices]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(eligible.map((i) => i.paymentId)));
  const [count, setCount] = useState(3);
  const today = businessDay();
  const [firstDueDate, setFirstDueDate] = useState(today);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const total = Math.round(eligible.filter((i) => selected.has(i.paymentId)).reduce((sum, i) => sum + i.balanceCve, 0) * 100) / 100;
  const preview = useMemo(() => {
    if (total < count || !firstDueDate || firstDueDate < today) return [];
    const amounts = splitInstallments(total, count);
    return monthlyDueDates(firstDueDate, count).map((dueDate, i) => ({ seq: i + 1, dueDate, amountCve: amounts[i] }));
  }, [total, count, firstDueDate, today]);

  if (eligible.length === 0) {
    return <EmptyState size="sm" icon={Handshake} title="Sem dívida para renegociar" />;
  }

  const pickSelection: DataTableSelection = {
    isSelected: (key) => selected.has(Number(key)),
    onToggleRow: (key) => setSelected((current) => {
      const next = new Set(current);
      if (next.has(Number(key))) next.delete(Number(key));
      else next.add(Number(key));
      return next;
    }),
    headerState: selected.size === 0 ? 'none' : selected.size === eligible.length ? 'all' : 'some',
    onToggleAll: () => setSelected(selected.size === eligible.length ? new Set() : new Set(eligible.map((i) => i.paymentId)))
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await authFetch(`${API}/clients/${finance.client.id}/payment-plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIds: [...selected], installments: count, firstDueDate, notes: notes.trim() || null })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        toast(body.error || 'Não foi possível criar o acordo.', 'error');
        return;
      }
      toast('Acordo de pagamento criado.', 'success');
      await onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="client-finance-plan-form" onSubmit={submit}>
      <DataTable<ClientFinanceInvoice>
        rows={eligible}
        rowKey={(i) => i.paymentId}
        columns={PICK_COLUMNS}
        selection={pickSelection}
        defaultSort={{ key: 'Vencimento', direction: 'asc' }}
        gridTemplateColumns="minmax(112px, 1fr) 104px 104px 112px"
        empty={null}
      />

      <div className="client-finance-plan-fields">
        <Select label="Prestações" value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>
          {Array.from({ length: MAX_INSTALLMENTS - MIN_INSTALLMENTS + 1 }, (_, i) => MIN_INSTALLMENTS + i).map((n) => (
            <option key={n} value={n}>{n} meses</option>
          ))}
        </Select>
        <Field
          label="1.ª prestação"
          type="date"
          min={today}
          value={firstDueDate}
          onChange={(e) => setFirstDueDate(e.target.value)}
        />
        <div className="client-finance-plan-total">
          <span>Total</span>
          <b>{formatCve(total)}</b>
        </div>
      </div>

      <Textarea label="Notas" wide={false} value={notes} maxLength={500} rows={2} onChange={(e) => setNotes(e.target.value)} />

      {preview.length > 0 && (
        <DataTable<Installment>
          rows={preview.map((p) => ({ ...p, status: 'por_pagar' as const }))}
          rowKey={(i) => i.seq}
          columns={INSTALLMENT_COLUMNS.slice(0, 3)}
          defaultSort={{ key: 'Nº', direction: 'asc' }}
          gridTemplateColumns="56px 120px 128px"
          empty={null}
        />
      )}

      <div className="client-finance-plan-submit">
        <Button type="submit" loading={submitting} disabled={preview.length === 0}>Criar acordo</Button>
      </div>
    </form>
  );
}
