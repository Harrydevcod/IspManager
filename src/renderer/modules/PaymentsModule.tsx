import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Eye, FileText, MessageCircle, ReceiptText, Send, X } from 'lucide-react';
import { Badge, DataList, DetailModal, Dialog, FilterBar, Message, useToast } from '../components';
import { formatCve } from '../lib/format';
import { authFetch, useAuth } from '../lib/auth';
import { fallbackWhatsappTemplate, normalizeWhatsappPhone, renderWhatsappMessage, sendWhatsappViaUltraMsg } from '../lib/whatsapp';
import type { PaymentRow } from '../types';

// ---------------------------------------------------------------------------
// Payment-private types (local to this module)
// ---------------------------------------------------------------------------

type PaymentMethod = 'numerario' | 'transferencia' | 'outro';
type PaymentActionMode = 'pay' | 'cancel' | 'whatsapp';
type PaymentSortMode = 'dueAsc' | 'dueDesc' | 'amountDesc' | 'clientAsc';

type BillingPreviewRow = {
  serviceId: number;
  clientId: number;
  clientName: string;
  planName: string | null;
  amountCve: number;
  dueDate: string;
};

type BillingPreview = {
  referenceMonth: string;
  activeServices: number;
  alreadyBilled: number;
  toCreate: BillingPreviewRow[];
  totalCve: number;
};

// ---------------------------------------------------------------------------
// Reminder helpers (moved verbatim from App.tsx L694–L712)
// ---------------------------------------------------------------------------

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function paymentReminderStorageKey(paymentId: number, isoDate: string) {
  return `ispm.wa-reminder.${paymentId}.${isoDate}`;
}

function wasReminderSentToday(paymentId: number) {
  try {
    return window.localStorage.getItem(paymentReminderStorageKey(paymentId, todayIso())) === '1';
  } catch {
    return false;
  }
}

function markReminderSent(paymentId: number) {
  try {
    window.localStorage.setItem(paymentReminderStorageKey(paymentId, todayIso()), '1');
  } catch {
    /* localStorage unavailable — silent */
  }
}

// ---------------------------------------------------------------------------
// Payment status helpers
// ---------------------------------------------------------------------------

const paymentStatusTone = (status: PaymentRow['status']): 'success' | 'info' | 'danger' | 'neutral' => {
  switch (status) {
    case 'paid': return 'success';
    case 'pending': return 'info';
    case 'overdue': return 'danger';
    case 'cancelled': return 'neutral';
  }
};

const statusLabel = (status: PaymentRow['status']): string => status;

// ---------------------------------------------------------------------------
// PaymentsModule
// ---------------------------------------------------------------------------

export function PaymentsModule() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [referenceMonth, setReferenceMonth] = useState(currentMonth);
  const [statusFilter, setStatusFilter] = useState<'all' | PaymentRow['status']>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [selectedPayment, setSelectedPayment] = useState<PaymentRow | null>(null);
  const [actionMode, setActionMode] = useState<PaymentActionMode | null>(null);
  const [actionPaymentId, setActionPaymentId] = useState<number | null>(null);
  const [payMethod, setPayMethod] = useState<PaymentMethod>('numerario');
  const [payDate, setPayDate] = useState<string>(todayIso());
  const [cancelReason, setCancelReason] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [monthlyPreview, setMonthlyPreview] = useState<BillingPreview | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [sortMode, setSortMode] = useState<PaymentSortMode>('dueAsc');
  const [pdfPreview, setPdfPreview] = useState<{ payment: PaymentRow; type: 'invoice' | 'receipt' } | null>(null);
  const [overduePreview, setOverduePreview] = useState<{
    total: number;
    eligible: Array<{ paymentId: number; clientName: string; clientCode: string; phone: string | null; amountCve: number; dueDate: string; daysOverdue: number }>;
    skipped: Array<{ paymentId: number; clientName: string; reason?: string }>;
  } | null>(null);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifySending, setNotifySending] = useState(false);
  const { toast } = useToast();
  const auth = useAuth();
  const [companyName, setCompanyName] = useState('ISPM');
  const [whatsappTemplate, setWhatsappTemplate] = useState(fallbackWhatsappTemplate);
  const [whatsappTick, setWhatsappTick] = useState(0);

  function loadPayments() {
    return authFetch('http://127.0.0.1:3001/api/payments')
      .then((response) => response.json() as Promise<PaymentRow[]>)
      .then((data) => {
        setPayments(data);
        return data;
      })
      .catch(() => {
        setPayments([]);
        return [];
      });
  }

  useEffect(() => {
    void loadPayments();
  }, []);

  useEffect(() => {
    let cancelled = false;
    authFetch('http://127.0.0.1:3001/api/settings')
      .then((response) => response.ok ? response.json() : null)
      .then((settings: { companyName?: string; whatsappTemplate?: string } | null) => {
        if (cancelled || !settings) return;
        setCompanyName(settings.companyName || 'ISPM');
        setWhatsappTemplate(settings.whatsappTemplate || fallbackWhatsappTemplate);
      })
      .catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSelectedPayment(null);
    closeActionForm();
  }, [referenceMonth, showAllMonths]);

  function closeActionForm() {
    setActionMode(null);
    setActionPaymentId(null);
    setCancelReason('');
  }

  function openPayForm(payment: PaymentRow) {
    setSelectedPayment(payment);
    setActionMode('pay');
    setActionPaymentId(payment.id);
    setPayMethod((payment.paymentMethod as PaymentMethod | null) || 'numerario');
    setPayDate(payment.paymentDate?.slice(0, 10) || todayIso());
    window.setTimeout(() => {
      document.getElementById('payment-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  function openCancelForm(payment: PaymentRow) {
    setSelectedPayment(payment);
    setActionMode('cancel');
    setActionPaymentId(payment.id);
    setCancelReason('');
    window.setTimeout(() => {
      document.getElementById('payment-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  function openWhatsappForm(payment: PaymentRow) {
    setSelectedPayment(payment);
    setActionMode('whatsapp');
    setActionPaymentId(payment.id);
    window.setTimeout(() => {
      document.getElementById('payment-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  function whatsappMessageFor(payment: PaymentRow) {
    return renderWhatsappMessage(
      whatsappTemplate,
      {
        fullName: payment.clientName,
        clientCode: payment.clientCode || '',
        phone: payment.clientPhone
      },
      companyName
    );
  }

  async function submitWhatsapp(payment: PaymentRow) {
    if (!normalizeWhatsappPhone(payment.clientPhone)) {
      setMessage('Cliente sem telefone valido para WhatsApp.');
      return;
    }
    setSubmitting(true);
    try {
      await sendWhatsappViaUltraMsg(payment.clientPhone, whatsappMessageFor(payment));
      markReminderSent(payment.id);
      setWhatsappTick((tick) => tick + 1);
      setMessage(`Lembrete WhatsApp enviado para ${payment.clientName}.`);
      closeActionForm();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Nao foi possivel enviar WhatsApp.');
    } finally {
      setSubmitting(false);
    }
  }

  async function openMonthlyPreview() {
    setMonthlyLoading(true);
    setMonthlyPreview(null);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/billing/preview-monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceMonth })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({ error: 'Nao foi possivel pre-visualizar.' })) as { error?: string };
        setMessage(result.error || 'Nao foi possivel pre-visualizar.');
        return;
      }
      const preview = await response.json() as BillingPreview;
      setMonthlyPreview(preview);
      window.setTimeout(() => {
        document.getElementById('monthly-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 0);
    } finally {
      setMonthlyLoading(false);
    }
  }

  function closeMonthlyPreview() {
    setMonthlyPreview(null);
  }

  async function confirmMonthlyGenerate() {
    if (!monthlyPreview) return;
    setMonthlyLoading(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/billing/generate-monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceMonth: monthlyPreview.referenceMonth })
      });
      const result = await response.json() as { created?: number; activeServices?: number; error?: string };
      setMessage(result.error || `Mensalidades geradas: ${result.created || 0} de ${result.activeServices || 0} servicos ativos`);
      await loadPayments();
      closeMonthlyPreview();
    } finally {
      setMonthlyLoading(false);
    }
  }

  async function submitPayment(paymentId: number, method: PaymentMethod, date: string) {
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${paymentId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethod: method, paymentDate: date })
      });
      if (response.ok) {
        setMessage('Pagamento registado e recibo emitido.');
        const refreshedPayments = await loadPayments();
        setSelectedPayment((current) => refreshedPayments.find((item) => item.id === (current?.id || paymentId)) || current);
        closeActionForm();
        return;
      }
      const result = await response.json().catch(() => ({ error: 'Nao foi possivel registar o pagamento.' })) as { error?: string };
      setMessage(result.error || 'Nao foi possivel registar o pagamento.');
    } finally {
      setSubmitting(false);
    }
  }

  async function markOverdue(payment: PaymentRow) {
    const response = await authFetch(`http://127.0.0.1:3001/api/payments/${payment.id}/overdue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (response.ok) {
      setMessage('Cobranca marcada em atraso.');
      const refreshedPayments = await loadPayments();
      setSelectedPayment((current) => refreshedPayments.find((item) => item.id === (current?.id || payment.id)) || current);
    }
  }

  async function submitCancel(paymentId: number, reason: string) {
    if (!reason.trim()) {
      setMessage('Indique o motivo da anulacao.');
      return;
    }
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${paymentId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() })
      });
      if (response.ok) {
        setMessage('Pagamento anulado.');
        const refreshedPayments = await loadPayments();
        setSelectedPayment((current) => refreshedPayments.find((item) => item.id === (current?.id || paymentId)) || current);
        closeActionForm();
        return;
      }
      const result = await response.json().catch(() => ({ error: 'Nao foi possivel anular o pagamento.' })) as { error?: string };
      setMessage(result.error || 'Nao foi possivel anular o pagamento.');
    } finally {
      setSubmitting(false);
    }
  }

  function openPdf(payment: PaymentRow, type: 'invoice' | 'receipt') {
    setPdfPreview({ payment, type });
  }

  async function openOverduePreview() {
    setNotifyLoading(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/payments/notify-overdue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true })
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        toast(result.error || 'Nao foi possivel carregar atrasados.', 'error');
        return;
      }
      const data = await response.json() as Awaited<NonNullable<typeof overduePreview>> & { dryRun: boolean };
      setOverduePreview({ total: data.total, eligible: data.eligible, skipped: data.skipped });
    } catch {
      toast('Falha de rede ao consultar atrasados.', 'error');
    } finally {
      setNotifyLoading(false);
    }
  }

  function closeOverduePreview() {
    if (notifySending) return;
    setOverduePreview(null);
  }

  async function confirmNotifyOverdue() {
    if (!overduePreview || overduePreview.eligible.length === 0) return;
    setNotifySending(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/payments/notify-overdue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false })
      });
      const data = await response.json() as { sent?: number; failed?: Array<{ clientName: string; reason?: string }>; error?: string };
      if (!response.ok) {
        toast(data.error || 'Falha no envio em massa.', 'error');
        return;
      }
      const failedCount = data.failed?.length || 0;
      if (failedCount === 0) {
        toast(`Lembrete WhatsApp enviado a ${data.sent} cliente(s).`, 'success');
      } else {
        toast(`Enviadas ${data.sent}. Falharam ${failedCount}.`, failedCount === overduePreview.eligible.length ? 'error' : 'info');
      }
      setOverduePreview(null);
      await loadPayments();
    } catch {
      toast('Falha de rede ao enviar lembretes.', 'error');
    } finally {
      setNotifySending(false);
    }
  }

  function closePdfPreview() {
    setPdfPreview(null);
  }

  function documentUrl(payment: PaymentRow, type: 'invoice' | 'receipt', inline = false) {
    const suffix = type === 'invoice' ? 'invoice.pdf' : 'receipt.pdf';
    const params = new URLSearchParams();
    if (inline) params.set('inline', '1');
    if (auth.token) params.set('token', auth.token);
    const query = params.toString();
    return `http://127.0.0.1:3001/api/payments/${payment.id}/${suffix}${query ? `?${query}` : ''}`;
  }

  function downloadPdf(payment: PaymentRow, type: 'invoice' | 'receipt') {
    const url = documentUrl(payment, type);
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function previewPaymentDocument(payment: PaymentRow) {
    setSelectedPayment(payment);
    closeActionForm();
    window.setTimeout(() => {
      document.getElementById('payment-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }

  const normalizedSearch = search.trim().toLowerCase();
  const visiblePayments = payments
    .filter((payment) => {
      const monthMatches = showAllMonths || payment.referenceMonth === referenceMonth;
      const statusMatches = statusFilter === 'all' || payment.status === statusFilter;
      const searchMatches = !normalizedSearch
        || payment.clientName.toLowerCase().includes(normalizedSearch)
        || (payment.invoiceNumber || '').toLowerCase().includes(normalizedSearch)
        || (payment.receiptNumber || '').toLowerCase().includes(normalizedSearch)
        || (payment.clientNif || '').toLowerCase().includes(normalizedSearch)
        || (payment.clientPhone || '').toLowerCase().includes(normalizedSearch)
        || (payment.clientCode || '').toLowerCase().includes(normalizedSearch);
      return monthMatches && statusMatches && searchMatches;
    })
    .sort((a, b) => {
      switch (sortMode) {
        case 'dueDesc':
          return b.dueDate.localeCompare(a.dueDate) || a.clientName.localeCompare(b.clientName);
        case 'amountDesc':
          return b.amountCve - a.amountCve;
        case 'clientAsc':
          return a.clientName.localeCompare(b.clientName);
        case 'dueAsc':
        default:
          return a.dueDate.localeCompare(b.dueDate) || a.clientName.localeCompare(b.clientName);
      }
    });
  const previewPayment = selectedPayment || visiblePayments[0] || null;
  void whatsappTick; // re-render when reminder flag changes

  const totals = visiblePayments.reduce(
    (acc, payment) => {
      if (payment.status === 'pending') {
        acc.pending.count += 1;
        acc.pending.sum += payment.amountCve;
      } else if (payment.status === 'paid') {
        acc.paid.count += 1;
        acc.paid.sum += payment.amountCve;
      } else if (payment.status === 'overdue') {
        acc.overdue.count += 1;
        acc.overdue.sum += payment.amountCve;
      }
      return acc;
    },
    {
      pending: { count: 0, sum: 0 },
      paid: { count: 0, sum: 0 },
      overdue: { count: 0, sum: 0 }
    }
  );

  const showActionForm = actionMode !== null && actionPaymentId !== null && selectedPayment?.id === actionPaymentId;

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Pagamentos</h2>
        </div>
        <div className="inline-actions">
          <input type="month" value={referenceMonth} onChange={(event) => setReferenceMonth(event.target.value)} />
          <button type="button" onClick={() => void openMonthlyPreview()} disabled={monthlyLoading}>
            {monthlyLoading && !monthlyPreview ? 'A calcular...' : 'Gerar mensalidades'}
          </button>
          <button type="button" onClick={() => void openOverduePreview()} disabled={notifyLoading}>
            <Send size={14} />
            {notifyLoading ? 'A consultar...' : 'Notificar atrasados'}
          </button>
        </div>
      </div>

      {/* Message primitive — renders p.module-message, byte-identical to original */}
      {message && <Message>{message}</Message>}

      {/* FilterBar primitive — renders div.filter-bar, byte-identical to original.
          Children kept inline: Field renders label.field>span.field-label+input which
          differs from original bare <label>Text<input/> and bare <input class="payments-search"/>.
          Keeping children inline preserves byte-identical DOM. */}
      <FilterBar>
        <input
          type="search"
          placeholder="Cliente, NIF, telefone, fatura ou recibo"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="payments-search"
        />
        <label>
          Estado
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | PaymentRow['status'])}>
            <option value="all">Todos</option>
            <option value="pending">Pendente</option>
            <option value="overdue">Atraso</option>
            <option value="paid">Pago</option>
            <option value="cancelled">Anulado</option>
          </select>
        </label>
        <label>
          Ordenar
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as PaymentSortMode)}>
            <option value="dueAsc">Vencimento ↑</option>
            <option value="dueDesc">Vencimento ↓</option>
            <option value="amountDesc">Valor ↓</option>
            <option value="clientAsc">Cliente A-Z</option>
          </select>
        </label>
        <button type="button" onClick={() => setShowAllMonths((current) => !current)} className={showAllMonths ? 'active' : ''}>
          {showAllMonths ? 'Mês atual' : 'Todos os meses'}
        </button>
        <button type="button" onClick={() => {
          setStatusFilter('all');
          setReferenceMonth(currentMonth);
          setShowAllMonths(false);
          setSearch('');
          setSortMode('dueAsc');
        }}>
          Limpar filtros
        </button>
        <small>{visiblePayments.length} cobrancas{showAllMonths ? ' (todos os meses)' : ` em ${referenceMonth}`}</small>
      </FilterBar>

      <div className="payments-totals" aria-label="Totais filtrados">
        <span className="payments-totals-label">Totais (filtrados)</span>
        <span className="payments-total-chip pending">
          <small>Pendente</small>
          <strong>{formatCve(totals.pending.sum)}</strong>
          <em>{totals.pending.count}</em>
        </span>
        <span className="payments-total-chip overdue">
          <small>Atraso</small>
          <strong>{formatCve(totals.overdue.sum)}</strong>
          <em>{totals.overdue.count}</em>
        </span>
        <span className="payments-total-chip paid">
          <small>Pago</small>
          <strong>{formatCve(totals.paid.sum)}</strong>
          <em>{totals.paid.count}</em>
        </span>
      </div>

      {monthlyPreview && (
        <div className="monthly-preview" id="monthly-preview">
          <div className="module-header">
            <div>
              <p className="eyebrow">Pre-visualizacao da geracao</p>
              <h2>Mensalidades de {monthlyPreview.referenceMonth}</h2>
            </div>
            <div className="inline-actions">
              <button
                type="button"
                onClick={() => void confirmMonthlyGenerate()}
                disabled={monthlyLoading || monthlyPreview.toCreate.length === 0}
              >
                {monthlyLoading ? 'A gerar...' : `Confirmar e gerar (${monthlyPreview.toCreate.length})`}
              </button>
              <button type="button" onClick={closeMonthlyPreview} disabled={monthlyLoading}>
                Cancelar
              </button>
            </div>
          </div>
          <div className="monthly-preview-summary">
            <span className="monthly-preview-chip">
              <small>Servicos ativos</small>
              <strong>{monthlyPreview.activeServices}</strong>
            </span>
            <span className="monthly-preview-chip">
              <small>Ja cobrados</small>
              <strong>{monthlyPreview.alreadyBilled}</strong>
            </span>
            <span className="monthly-preview-chip highlight">
              <small>A criar</small>
              <strong>{monthlyPreview.toCreate.length}</strong>
            </span>
            <span className="monthly-preview-chip highlight">
              <small>Total</small>
              <strong>{formatCve(monthlyPreview.totalCve)}</strong>
            </span>
          </div>
          {monthlyPreview.toCreate.length > 0 ? (
            <div className="monthly-preview-table" role="table" aria-label="Cobrancas a criar">
              <div className="monthly-preview-row monthly-preview-row--head" role="row">
                <span role="columnheader">Cliente</span>
                <span role="columnheader">Plano</span>
                <span role="columnheader">Vencimento</span>
                <span role="columnheader" className="monthly-preview-amount">Valor</span>
              </div>
              {monthlyPreview.toCreate.map((row) => (
                <div className="monthly-preview-row" role="row" key={row.serviceId}>
                  <span role="cell">{row.clientName}</span>
                  <span role="cell" className="monthly-preview-muted">{row.planName || '-'}</span>
                  <span role="cell" className="monthly-preview-muted">{row.dueDate}</span>
                  <span role="cell" className="monthly-preview-amount">{formatCve(row.amountCve)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="module-message">
              Nada a criar. Os {monthlyPreview.alreadyBilled} servicos ativos ja tem cobranca para este mes.
            </p>
          )}
        </div>
      )}

      {selectedPayment && (
        <DetailModal
          eyebrow="Pre-visualizacao"
          title={selectedPayment.clientName}
          className="payment-preview"
          id="payment-preview"
          actionsClassName="payment-preview-actions"
          onClose={() => { setSelectedPayment(null); closeActionForm(); }}
          actions={
            <>
              {selectedPayment.status !== 'cancelled' && (
                <button type="button" onClick={() => openPdf(selectedPayment, 'invoice')}>
                  <FileText size={16} />
                  Fatura PDF
                </button>
              )}
              {selectedPayment.status === 'paid' ? (
                <button type="button" onClick={() => openPdf(selectedPayment, 'receipt')}>
                  <ReceiptText size={16} />
                  Recibo PDF
                </button>
              ) : selectedPayment.status !== 'cancelled' ? (
                <button type="button" onClick={() => openPayForm(selectedPayment)}>
                  <CheckCircle2 size={16} />
                  Registar pagamento
                </button>
              ) : null}
              {selectedPayment.status !== 'paid' && selectedPayment.status !== 'cancelled' && normalizeWhatsappPhone(selectedPayment.clientPhone) && (
                <button
                  type="button"
                  onClick={() => openWhatsappForm(selectedPayment)}
                  disabled={wasReminderSentToday(selectedPayment.id)}
                  title={wasReminderSentToday(selectedPayment.id) ? 'Lembrete ja enviado hoje' : 'Enviar lembrete WhatsApp'}
                >
                  <MessageCircle size={16} />
                  {wasReminderSentToday(selectedPayment.id) ? 'Enviado hoje' : 'WhatsApp'}
                </button>
              )}
              {selectedPayment.status !== 'paid' && selectedPayment.status !== 'cancelled' && (
                <button type="button" onClick={() => openCancelForm(selectedPayment)}>
                  <X size={16} />
                  Anular
                </button>
              )}
            </>
          }
        >
          {showActionForm && actionMode === 'pay' && (
            <form
              className="payment-action-form"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void submitPayment(selectedPayment.id, payMethod, payDate);
              }}
            >
              <div>
                <p className="eyebrow">Registar pagamento</p>
                <strong>{formatCve(selectedPayment.amountCve)}</strong>
              </div>
              <label>
                Metodo
                <select value={payMethod} onChange={(event) => setPayMethod(event.target.value as PaymentMethod)} disabled={submitting}>
                  <option value="numerario">Numerario</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="outro">Outro</option>
                </select>
              </label>
              <label>
                Data
                <input type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} max={todayIso()} disabled={submitting} required />
              </label>
              <div className="inline-actions">
                <button type="submit" disabled={submitting || !payDate}>Confirmar</button>
                <button type="button" onClick={closeActionForm} disabled={submitting}>Cancelar</button>
              </div>
            </form>
          )}

          {showActionForm && actionMode === 'cancel' && (
            <form
              className="payment-action-form payment-action-form--cancel"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void submitCancel(selectedPayment.id, cancelReason);
              }}
            >
              <div>
                <p className="eyebrow">Anular pagamento</p>
                <small>O pagamento e marcado anulado e o motivo fica registado nas notas.</small>
              </div>
              <label>
                Motivo
                <textarea
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                  rows={3}
                  required
                  minLength={3}
                  placeholder="Ex: cobranca duplicada"
                  disabled={submitting}
                />
              </label>
              <div className="inline-actions">
                <button type="submit" disabled={submitting || cancelReason.trim().length < 3}>Confirmar anulacao</button>
                <button type="button" onClick={closeActionForm} disabled={submitting}>Cancelar</button>
              </div>
            </form>
          )}

          {showActionForm && actionMode === 'whatsapp' && (
            <form
              className="payment-action-form payment-action-form--whatsapp"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void submitWhatsapp(selectedPayment);
              }}
            >
              <div>
                <p className="eyebrow">Lembrete WhatsApp</p>
                <small>
                  Para <strong>{normalizeWhatsappPhone(selectedPayment.clientPhone) || '—'}</strong>{' '}
                  · template em Configuracoes
                </small>
              </div>
              <label>
                Mensagem
                <textarea
                  value={whatsappMessageFor(selectedPayment)}
                  readOnly
                  rows={4}
                />
              </label>
              <div className="inline-actions">
                <button type="submit" disabled={submitting || !normalizeWhatsappPhone(selectedPayment.clientPhone)}>
                  {submitting ? 'A enviar...' : 'Enviar'}
                </button>
                <button type="button" onClick={closeActionForm} disabled={submitting}>Cancelar</button>
              </div>
            </form>
          )}

          <div className="document-preview">
            <span>{selectedPayment.invoiceNumber ? `Fatura ${selectedPayment.invoiceNumber}` : 'Fatura por emitir'}</span>
            <strong>{formatCve(selectedPayment.amountCve)}</strong>
            <small>
              Mes {selectedPayment.referenceMonth} - vencimento {selectedPayment.dueDate} - {selectedPayment.status}
            </small>
          </div>
          {selectedPayment.status !== 'cancelled' ? (
            <iframe
              className="payment-pdf-preview"
              title={`Pre-visualizacao da fatura ${selectedPayment.invoiceNumber || selectedPayment.id}`}
              src={documentUrl(selectedPayment, 'invoice', true)}
            />
          ) : (
            <p className="module-message">Pagamento anulado. Nenhuma fatura ou recibo pode ser emitido.</p>
          )}
          <dl>
            <div><dt>Mes</dt><dd>{selectedPayment.referenceMonth}</dd></div>
            <div><dt>Valor</dt><dd>{formatCve(selectedPayment.amountCve)}</dd></div>
            <div><dt>Fatura</dt><dd>{selectedPayment.invoiceNumber || '-'}</dd></div>
            <div><dt>Recibo</dt><dd>{selectedPayment.receiptNumber || '-'}</dd></div>
            <div><dt>Metodo</dt><dd>{selectedPayment.paymentMethod || '-'}</dd></div>
            <div><dt>Data pagamento</dt><dd>{selectedPayment.paymentDate?.slice(0, 10) || '-'}</dd></div>
            <div><dt>Estado</dt><dd>{selectedPayment.status}</dd></div>
          </dl>
        </DetailModal>
      )}

      <DataList
        rows={visiblePayments}
        rowKey={(p) => p.id}
        activeKey={previewPayment?.id ?? null}
        columns={[
          {
            cell: (p) => (
              <span>
                <strong>{p.clientName}</strong>
                <small>{p.referenceMonth} - FT {p.invoiceNumber || '-'}</small>
              </span>
            )
          },
          {
            cell: (p) => <Badge tone={paymentStatusTone(p.status)}>{statusLabel(p.status)}</Badge>
          },
          {
            cell: (p) => <b>{formatCve(p.amountCve)}</b>
          }
        ]}
        actions={(p) => (
          <>
            <button type="button" title="Pre-visualizar" onClick={() => previewPaymentDocument(p)}>
              <Eye size={16} />
            </button>
            {p.status !== 'cancelled' && (
              <button type="button" title="Fatura PDF" onClick={() => openPdf(p, 'invoice')}>
                <FileText size={16} />
              </button>
            )}
            {p.status === 'pending' && (
              <button type="button" title="Marcar atraso" onClick={() => void markOverdue(p)}>
                <AlertTriangle size={16} />
              </button>
            )}
            {p.status === 'paid' ? (
              <button type="button" title="Recibo PDF" onClick={() => openPdf(p, 'receipt')}>
                <ReceiptText size={16} />
              </button>
            ) : p.status !== 'cancelled' ? (
              <button type="button" title="Registar pagamento" onClick={() => openPayForm(p)}>
                <CheckCircle2 size={16} />
              </button>
            ) : null}
            {p.status !== 'paid' && p.status !== 'cancelled' && normalizeWhatsappPhone(p.clientPhone) && (
              <button
                type="button"
                title={wasReminderSentToday(p.id) ? 'Lembrete WhatsApp ja enviado hoje' : 'Lembrete WhatsApp'}
                onClick={() => openWhatsappForm(p)}
                disabled={wasReminderSentToday(p.id)}
              >
                <MessageCircle size={16} />
              </button>
            )}
            {p.status !== 'paid' && p.status !== 'cancelled' && (
              <button type="button" title="Anular pagamento" onClick={() => openCancelForm(p)}>
                <X size={16} />
              </button>
            )}
          </>
        )}
        onRowClick={(p) => previewPaymentDocument(p)}
        empty={<p className="module-message">Nenhuma cobranca encontrada para os filtros atuais.</p>}
      />

      <Dialog
        open={!!overduePreview}
        onClose={closeOverduePreview}
        eyebrow="WhatsApp em massa"
        title="Notificar atrasados"
        size="md"
        closeOnBackdrop={!notifySending}
        actions={
          <>
            <button type="button" onClick={closeOverduePreview} disabled={notifySending}>Cancelar</button>
            <button
              type="button"
              className="primary"
              onClick={() => void confirmNotifyOverdue()}
              disabled={notifySending || !overduePreview || overduePreview.eligible.length === 0}
            >
              {notifySending
                ? 'A enviar...'
                : overduePreview && overduePreview.eligible.length > 0
                  ? `Enviar para ${overduePreview.eligible.length}`
                  : 'Sem destinatarios'}
            </button>
          </>
        }
      >
        {overduePreview && (
          <div className="overdue-notify">
            <p className="overdue-notify-summary">
              <strong>{overduePreview.total}</strong> pagamento(s) em atraso.{' '}
              <strong>{overduePreview.eligible.length}</strong> elegivel(eis) para WhatsApp.{' '}
              {overduePreview.skipped.length > 0 && (
                <span className="overdue-notify-skip">
                  {overduePreview.skipped.length} ignorado(s) (opt-out ou sem telefone).
                </span>
              )}
            </p>

            {overduePreview.eligible.length > 0 ? (
              <ul className="overdue-notify-list">
                {overduePreview.eligible.map((row) => (
                  <li key={row.paymentId}>
                    <div className="overdue-notify-meta">
                      <strong>{row.clientName}</strong>
                      <small>{row.clientCode} - {row.phone}</small>
                    </div>
                    <Badge tone="danger">{row.daysOverdue}d</Badge>
                    <span className="overdue-notify-amount">{formatCve(row.amountCve)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="module-message">Sem clientes elegiveis para envio em massa.</p>
            )}

            {overduePreview.skipped.length > 0 && (
              <details className="overdue-notify-skipped">
                <summary>Ignorados ({overduePreview.skipped.length})</summary>
                <ul>
                  {overduePreview.skipped.map((row) => (
                    <li key={row.paymentId}>
                      {row.clientName} <small>({row.reason})</small>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!pdfPreview}
        onClose={closePdfPreview}
        eyebrow={pdfPreview?.type === 'receipt' ? 'Recibo' : 'Fatura'}
        title={
          pdfPreview
            ? pdfPreview.type === 'receipt'
              ? `Recibo ${pdfPreview.payment.receiptNumber || pdfPreview.payment.id}`
              : `Fatura ${pdfPreview.payment.invoiceNumber || pdfPreview.payment.id}`
            : ''
        }
        size="lg"
        actions={
          <>
            <button type="button" onClick={closePdfPreview}>Fechar</button>
            {pdfPreview && (
              <button
                type="button"
                className="primary"
                onClick={() => downloadPdf(pdfPreview.payment, pdfPreview.type)}
              >
                <Download size={14} /> Descarregar
              </button>
            )}
          </>
        }
      >
        {pdfPreview && (
          <iframe
            className="pdf-dialog-frame"
            title={pdfPreview.type === 'receipt' ? 'Pre-visualizacao do recibo' : 'Pre-visualizacao da fatura'}
            src={documentUrl(pdfPreview.payment, pdfPreview.type, true)}
          />
        )}
      </Dialog>
    </section>
  );
}
