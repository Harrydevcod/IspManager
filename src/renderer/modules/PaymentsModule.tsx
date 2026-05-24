import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Eye, FileText, MessageCircle, ReceiptText, RotateCcw, Send, Undo2, X } from 'lucide-react';
import { Badge, Button, DataList, DetailPanel, Dialog, EmptyState, Field, FilterBar, Message, Select, Textarea, useToast } from '../components';
import { formatCve } from '../lib/format';
import { authFetch, useAuth } from '../lib/auth';
import {
  fallbackWhatsappInvoiceReadyTemplate,
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReceiptTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  normalizeWhatsappPhone,
  renderWhatsappMessage,
  sendWhatsappViaUltraMsg
} from '../lib/whatsapp';
import type { PaymentRow } from '../types';

// ---------------------------------------------------------------------------
// Payment-private types (local to this module)
// ---------------------------------------------------------------------------

type PaymentMethod = 'numerario' | 'transferencia' | 'outro';
type PaymentActionMode = 'pay' | 'cancel' | 'whatsapp';
type PaymentSortMode = 'dueAsc' | 'dueDesc' | 'amountDesc' | 'clientAsc';
type WhatsappNoticeType = 'overdue' | 'suspension';

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
  const [reversePreview, setReversePreview] = useState<{
    referenceMonth: string;
    total: number;
    eligibleCount: number;
    paidLockedCount: number;
    cancelledCount: number;
    totalCve: number;
    eligible: Array<{ id: number; clientName: string; clientCode: string | null; invoiceNumber: string | null; amountCve: number; dueDate: string; status: 'pending' | 'overdue' }>;
    paidLocked: Array<{ id: number; clientName: string; clientCode: string | null; invoiceNumber: string | null; amountCve: number }>;
  } | null>(null);
  const [reverseLoading, setReverseLoading] = useState(false);
  const [reverseSubmitting, setReverseSubmitting] = useState(false);
  const [individualRevert, setIndividualRevert] = useState<PaymentRow | null>(null);
  const [individualRevertSubmitting, setIndividualRevertSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [sortMode, setSortMode] = useState<PaymentSortMode>('dueAsc');
  const [pdfPreview, setPdfPreview] = useState<{ payment: PaymentRow; type: 'invoice' | 'receipt' } | null>(null);
  const [overduePreview, setOverduePreview] = useState<{
    noticeType: WhatsappNoticeType;
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
  const [whatsappInvoiceReadyTemplate, setWhatsappInvoiceReadyTemplate] = useState(fallbackWhatsappInvoiceReadyTemplate);
  const [whatsappReceiptTemplate, setWhatsappReceiptTemplate] = useState(fallbackWhatsappReceiptTemplate);
  const [whatsappOverdueTemplate, setWhatsappOverdueTemplate] = useState(fallbackWhatsappOverdueTemplate);
  const [whatsappSuspensionTemplate, setWhatsappSuspensionTemplate] = useState(fallbackWhatsappSuspensionTemplate);
  const [whatsappSuspensionNoticeDays, setWhatsappSuspensionNoticeDays] = useState(15);
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
      .then((settings: {
        companyName?: string;
        whatsappTemplate?: string;
        whatsappInvoiceReadyTemplate?: string;
        whatsappReceiptTemplate?: string;
        whatsappOverdueTemplate?: string;
        whatsappSuspensionTemplate?: string;
        whatsappSuspensionNoticeDays?: number;
      } | null) => {
        if (cancelled || !settings) return;
        setCompanyName(settings.companyName || 'ISPM');
        setWhatsappTemplate(settings.whatsappTemplate || fallbackWhatsappTemplate);
        setWhatsappInvoiceReadyTemplate(settings.whatsappInvoiceReadyTemplate || fallbackWhatsappInvoiceReadyTemplate);
        setWhatsappReceiptTemplate(settings.whatsappReceiptTemplate || fallbackWhatsappReceiptTemplate);
        setWhatsappOverdueTemplate(settings.whatsappOverdueTemplate || fallbackWhatsappOverdueTemplate);
        setWhatsappSuspensionTemplate(settings.whatsappSuspensionTemplate || fallbackWhatsappSuspensionTemplate);
        setWhatsappSuspensionNoticeDays(settings.whatsappSuspensionNoticeDays || 15);
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
    const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(`${payment.dueDate}T00:00:00`).getTime()) / 86_400_000));
    const template = payment.status === 'paid'
      ? whatsappReceiptTemplate
      : payment.status === 'overdue' && daysOverdue >= whatsappSuspensionNoticeDays
        ? whatsappSuspensionTemplate
        : payment.status === 'overdue'
          ? whatsappOverdueTemplate
          : payment.invoiceNumber
            ? whatsappInvoiceReadyTemplate
            : whatsappTemplate;

    return renderWhatsappMessage(
      template,
      {
        fullName: payment.clientName,
        clientCode: payment.clientCode || '',
        phone: payment.clientPhone
      },
      companyName,
      {
        amountCve: payment.amountCve,
        dueDate: payment.dueDate,
        referenceMonth: payment.referenceMonth,
        invoiceNumber: payment.invoiceNumber,
        receiptNumber: payment.receiptNumber,
        daysOverdue,
        suspensionDays: whatsappSuspensionNoticeDays
      }
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
      if (payment.status !== 'paid') {
        markReminderSent(payment.id);
      }
      setWhatsappTick((tick) => tick + 1);
      setMessage(`WhatsApp enviado para ${payment.clientName}.`);
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

  async function openReversePreview() {
    setReverseLoading(true);
    setReversePreview(null);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/billing/preview-reverse-monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceMonth })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({ error: 'Nao foi possivel pre-visualizar reversao.' })) as { error?: string };
        toast(result.error || 'Nao foi possivel pre-visualizar reversao.', 'error');
        return;
      }
      const preview = await response.json() as NonNullable<typeof reversePreview>;
      setReversePreview(preview);
    } catch {
      toast('Falha de rede ao consultar reversao.', 'error');
    } finally {
      setReverseLoading(false);
    }
  }

  function closeReversePreview() {
    if (reverseSubmitting) return;
    setReversePreview(null);
  }

  async function confirmReverseMonthly() {
    if (!reversePreview || reversePreview.eligibleCount === 0) return;
    setReverseSubmitting(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/billing/reverse-monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceMonth: reversePreview.referenceMonth })
      });
      const result = await response.json() as { reversed?: number; error?: string };
      if (!response.ok) {
        toast(result.error || 'Falha ao reverter mensalidades.', 'error');
        return;
      }
      toast(`Revertidas ${result.reversed || 0} cobranca(s) de ${reversePreview.referenceMonth}.`, 'success');
      setReversePreview(null);
      await loadPayments();
    } catch {
      toast('Falha de rede ao reverter mensalidades.', 'error');
    } finally {
      setReverseSubmitting(false);
    }
  }

  function openIndividualRevert(payment: PaymentRow) {
    setIndividualRevert(payment);
  }

  function closeIndividualRevert() {
    if (individualRevertSubmitting) return;
    setIndividualRevert(null);
  }

  async function confirmIndividualRevert() {
    if (!individualRevert) return;
    setIndividualRevertSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${individualRevert.id}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        toast(result.error || 'Falha ao reverter pagamento.', 'error');
        return;
      }
      toast(`Cobranca de ${individualRevert.clientName} (${individualRevert.referenceMonth}) revertida.`, 'success');
      setIndividualRevert(null);
      if (selectedPayment?.id === individualRevert.id) {
        setSelectedPayment(null);
        closeActionForm();
      }
      await loadPayments();
    } catch {
      toast('Falha de rede ao reverter pagamento.', 'error');
    } finally {
      setIndividualRevertSubmitting(false);
    }
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
      toast('Indique o motivo da anulacao.', 'error');
      return;
    }
    const target = payments.find((p) => p.id === paymentId);
    const wasPaid = target?.status === 'paid';
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${paymentId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() })
      });
      const result = await response.json().catch(() => ({})) as { error?: string; status?: string };
      if (!response.ok) {
        toast(result.error || 'Nao foi possivel anular o pagamento.', 'error');
        return;
      }
      const refreshedPayments = await loadPayments();
      const fresh = refreshedPayments.find((item) => item.id === paymentId);
      if (fresh?.status !== 'cancelled') {
        toast('A resposta nao confirmou a anulacao. Verifica o backend.', 'error');
        return;
      }
      toast(
        wasPaid
          ? `Pagamento anulado (FT ${fresh.invoiceNumber || fresh.id}). Receita do mes atualizada.`
          : 'Cobranca anulada.',
        'success'
      );
      setSelectedPayment((current) => refreshedPayments.find((item) => item.id === (current?.id || paymentId)) || current);
      closeActionForm();
    } catch {
      toast('Falha de rede ao anular pagamento.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function openPdf(payment: PaymentRow, type: 'invoice' | 'receipt') {
    setPdfPreview({ payment, type });
  }

  async function openOverduePreview(noticeType: WhatsappNoticeType = 'overdue') {
    setNotifyLoading(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/payments/notify-overdue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, noticeType })
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        toast(result.error || 'Nao foi possivel carregar atrasados.', 'error');
        return;
      }
      const data = await response.json() as Awaited<NonNullable<typeof overduePreview>> & { dryRun: boolean };
      setOverduePreview({ noticeType, total: data.total, eligible: data.eligible, skipped: data.skipped });
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
        body: JSON.stringify({ dryRun: false, noticeType: overduePreview.noticeType })
      });
      const data = await response.json() as { sent?: number; failed?: Array<{ clientName: string; reason?: string }>; error?: string };
      if (!response.ok) {
        toast(data.error || 'Falha no envio em massa.', 'error');
        return;
      }
      const failedCount = data.failed?.length || 0;
      if (failedCount === 0) {
        toast(`WhatsApp enviado a ${data.sent} cliente(s).`, 'success');
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
          <Field label="Mes" type="month" value={referenceMonth} onChange={(event) => setReferenceMonth(event.target.value)} />
          <Button variant="secondary" size="sm" onClick={() => void openMonthlyPreview()} disabled={monthlyLoading}>
            {monthlyLoading && !monthlyPreview ? 'A calcular...' : 'Gerar mensalidades'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void openReversePreview()}
            disabled={reverseLoading}
            title="Reverter mensalidades geradas para este mes"
          >
            <RotateCcw size={14} aria-hidden />
            {reverseLoading ? 'A consultar...' : 'Reverter mensalidades'}
          </Button>
          <Button variant="secondary" size="sm" leadingIcon={<Send size={14} aria-hidden />} onClick={() => void openOverduePreview()} disabled={notifyLoading}>
            {notifyLoading ? 'A consultar...' : 'Notificar atrasados'}
          </Button>
          <Button variant="secondary" size="sm" leadingIcon={<AlertTriangle size={14} aria-hidden />} onClick={() => void openOverduePreview('suspension')} disabled={notifyLoading}>
            Avisar suspensao
          </Button>
        </div>
      </div>

      {/* Message primitive — renders p.module-message, byte-identical to original */}
      {message && <Message>{message}</Message>}

      <FilterBar>
        <Field
          type="search"
          label="Pesquisar"
          aria-label="Pesquisar pagamentos"
          placeholder="Cliente, NIF, telefone, fatura ou recibo"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="payments-search"
        />
        <Select label="Estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | PaymentRow['status'])}>
          <option value="all">Todos</option>
          <option value="pending">Pendente</option>
          <option value="overdue">Atraso</option>
          <option value="paid">Pago</option>
          <option value="cancelled">Anulado</option>
        </Select>
        <Select label="Ordenar" value={sortMode} onChange={(event) => setSortMode(event.target.value as PaymentSortMode)}>
          <option value="dueAsc">Vencimento asc</option>
          <option value="dueDesc">Vencimento desc</option>
          <option value="amountDesc">Valor desc</option>
          <option value="clientAsc">Cliente A-Z</option>
        </Select>
        <Button variant="secondary" onClick={() => setShowAllMonths((current) => !current)} className={showAllMonths ? 'active' : ''}>
          {showAllMonths ? 'Mês atual' : 'Todos os meses'}
        </Button>
        <Button variant="secondary" onClick={() => {
          setStatusFilter('all');
          setReferenceMonth(currentMonth);
          setShowAllMonths(false);
          setSearch('');
          setSortMode('dueAsc');
        }}>
          Limpar filtros
        </Button>
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
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void confirmMonthlyGenerate()}
                disabled={monthlyLoading || monthlyPreview.toCreate.length === 0}
              >
                {monthlyLoading ? 'A gerar...' : `Confirmar e gerar (${monthlyPreview.toCreate.length})`}
              </Button>
              <Button variant="secondary" size="sm" onClick={closeMonthlyPreview} disabled={monthlyLoading}>
                Cancelar
              </Button>
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
            <Message>
              Nada a criar. Os {monthlyPreview.alreadyBilled} servicos ativos ja tem cobranca para este mes.
            </Message>
          )}
        </div>
      )}

      {selectedPayment && (
        <DetailPanel
          eyebrow="Pre-visualizacao"
          title={selectedPayment.clientName}
          className="payment-preview"
          id="payment-preview"
          actionsClassName="payment-preview-actions"
          onClose={() => { setSelectedPayment(null); closeActionForm(); }}
          actions={
            <>
              {selectedPayment.status !== 'cancelled' && (
                <Button variant="secondary" size="sm" leadingIcon={<FileText size={16} aria-hidden />} onClick={() => openPdf(selectedPayment, 'invoice')}>
                  Fatura PDF
                </Button>
              )}
              {selectedPayment.status === 'paid' ? (
                <Button variant="secondary" size="sm" leadingIcon={<ReceiptText size={16} aria-hidden />} onClick={() => openPdf(selectedPayment, 'receipt')}>
                  Recibo PDF
                </Button>
              ) : selectedPayment.status !== 'cancelled' ? (
                <Button variant="secondary" size="sm" leadingIcon={<CheckCircle2 size={16} aria-hidden />} onClick={() => openPayForm(selectedPayment)}>
                  Registar pagamento
                </Button>
              ) : null}
              {selectedPayment.status !== 'cancelled' && normalizeWhatsappPhone(selectedPayment.clientPhone) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openWhatsappForm(selectedPayment)}
                  disabled={selectedPayment.status !== 'paid' && wasReminderSentToday(selectedPayment.id)}
                  title={selectedPayment.status !== 'paid' && wasReminderSentToday(selectedPayment.id) ? 'Lembrete ja enviado hoje' : 'Enviar WhatsApp'}
                >
                  <MessageCircle size={16} aria-hidden />
                  {selectedPayment.status !== 'paid' && wasReminderSentToday(selectedPayment.id)
                    ? 'Enviado hoje'
                    : selectedPayment.status === 'paid'
                      ? 'Recibo WhatsApp'
                      : 'WhatsApp'}
                </Button>
              )}
              {selectedPayment.status !== 'cancelled' && (
                <Button
                  variant={selectedPayment.status === 'paid' ? 'danger' : 'secondary'}
                  size="sm"
                  onClick={() => openCancelForm(selectedPayment)}
                  className={selectedPayment.status === 'paid' ? 'danger-ghost' : undefined}
                  title={selectedPayment.status === 'paid'
                    ? 'Anular pagamento ja registado (ex: erro de faturacao)'
                    : 'Anular cobranca'}
                >
                  <X size={16} aria-hidden />
                  {selectedPayment.status === 'paid' ? 'Anular pago' : 'Anular'}
                </Button>
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
              <Select label="Metodo" value={payMethod} onChange={(event) => setPayMethod(event.target.value as PaymentMethod)} disabled={submitting}>
                <option value="numerario">Numerario</option>
                <option value="transferencia">Transferencia</option>
                <option value="outro">Outro</option>
              </Select>
              <Field label="Data" type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} max={todayIso()} disabled={submitting} required />
              <div className="inline-actions">
                <Button type="submit" disabled={submitting || !payDate}>Confirmar</Button>
                <Button variant="secondary" onClick={closeActionForm} disabled={submitting}>Cancelar</Button>
              </div>
            </form>
          )}

          {showActionForm && actionMode === 'cancel' && (() => {
            const wasPaid = selectedPayment.status === 'paid';
            const minLen = wasPaid ? 10 : 3;
            return (
              <form
                className={`payment-action-form payment-action-form--cancel${wasPaid ? ' payment-action-form--cancel-paid' : ''}`}
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  void submitCancel(selectedPayment.id, cancelReason);
                }}
              >
                <div>
                  <p className="eyebrow">
                    {wasPaid ? 'Anular pagamento ja registado' : 'Anular pagamento'}
                  </p>
                  {wasPaid ? (
                    <small>
                      <strong>Atencao:</strong> anular um pagamento ja registado nao devolve dinheiro.
                      Marca a cobranca <strong>FT {selectedPayment.invoiceNumber || '-'}</strong>
                      {selectedPayment.receiptNumber ? ` / REC ${selectedPayment.receiptNumber}` : ''}
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
                          onClick={() => setCancelReason(suggestion)}
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
                    onChange={(event) => setCancelReason(event.target.value)}
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
                  <Button variant="secondary" onClick={closeActionForm} disabled={submitting}>Cancelar</Button>
                </div>
              </form>
            );
          })()}

          {showActionForm && actionMode === 'whatsapp' && (
            <form
              className="payment-action-form payment-action-form--whatsapp"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void submitWhatsapp(selectedPayment);
              }}
            >
              <div>
                <p className="eyebrow">
                  {selectedPayment.status === 'paid'
                    ? 'Recibo WhatsApp'
                    : selectedPayment.status === 'overdue'
                      ? 'Aviso WhatsApp'
                      : 'Fatura WhatsApp'}
                </p>
                <small>
                  Para <strong>{normalizeWhatsappPhone(selectedPayment.clientPhone) || '—'}</strong>{' '}
                  · template em Configuracoes
                </small>
              </div>
              <Textarea
                label="Mensagem"
                value={whatsappMessageFor(selectedPayment)}
                readOnly
                rows={4}
              />
              <div className="inline-actions">
                <Button type="submit" disabled={submitting || !normalizeWhatsappPhone(selectedPayment.clientPhone)}>
                  {submitting ? 'A enviar...' : 'Enviar'}
                </Button>
                <Button variant="secondary" onClick={closeActionForm} disabled={submitting}>Cancelar</Button>
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
            <Message>Pagamento anulado. Nenhuma fatura ou recibo pode ser emitido.</Message>
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
        </DetailPanel>
      )}

      <DataList
        rows={visiblePayments}
        rowKey={(p) => p.id}
        activeKey={previewPayment?.id ?? null}
        columns={[
          {
            cell: (p) => (
              <span>
                <small className="entity-code">{p.clientCode || '—'}</small>
                <strong>{p.clientName}</strong>
                <small>{p.referenceMonth} · FT {p.invoiceNumber || '-'}</small>
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
            <Button variant="icon" size="sm" title="Pre-visualizar" onClick={() => previewPaymentDocument(p)}>
              <Eye size={16} aria-hidden />
            </Button>
            {p.status !== 'cancelled' && (
              <Button variant="icon" size="sm" title="Fatura PDF" onClick={() => openPdf(p, 'invoice')}>
                <FileText size={16} aria-hidden />
              </Button>
            )}
            {p.status === 'pending' && (
              <Button variant="icon" size="sm" title="Marcar atraso" onClick={() => void markOverdue(p)}>
                <AlertTriangle size={16} aria-hidden />
              </Button>
            )}
            {p.status === 'paid' ? (
              <Button variant="icon" size="sm" title="Recibo PDF" onClick={() => openPdf(p, 'receipt')}>
                <ReceiptText size={16} aria-hidden />
              </Button>
            ) : p.status !== 'cancelled' ? (
              <Button variant="icon" size="sm" title="Registar pagamento" onClick={() => openPayForm(p)}>
                <CheckCircle2 size={16} aria-hidden />
              </Button>
            ) : null}
            {p.status !== 'paid' && p.status !== 'cancelled' && normalizeWhatsappPhone(p.clientPhone) && (
              <Button
                variant="icon"
                size="sm"
                title={wasReminderSentToday(p.id) ? 'Lembrete WhatsApp ja enviado hoje' : 'Lembrete WhatsApp'}
                onClick={() => openWhatsappForm(p)}
                disabled={wasReminderSentToday(p.id)}
              >
                <MessageCircle size={16} aria-hidden />
              </Button>
            )}
            {p.status !== 'cancelled' && (
              <Button
                variant="icon"
                size="sm"
                title={p.status === 'paid'
                  ? 'Anular pagamento ja registado (erro de faturacao)'
                  : 'Anular cobranca'}
                onClick={() => openCancelForm(p)}
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
                onClick={() => openIndividualRevert(p)}
              >
                <Undo2 size={16} aria-hidden />
              </Button>
            )}
          </>
        )}
        onRowClick={(p) => previewPaymentDocument(p)}
        empty={
          <EmptyState
            icon={ReceiptText}
            title="Nenhuma cobrança encontrada"
            description="Ajusta os filtros ou aguarda novos serviços para gerar cobranças."
          />
        }
      />

      <Dialog
        open={!!overduePreview}
        onClose={closeOverduePreview}
        eyebrow="WhatsApp em massa"
        title={overduePreview?.noticeType === 'suspension' ? 'Avisar suspensao' : 'Notificar atrasados'}
        size="md"
        closeOnBackdrop={!notifySending}
        actions={
          <>
            <Button variant="secondary" onClick={closeOverduePreview} disabled={notifySending}>Cancelar</Button>
            <Button
              onClick={() => void confirmNotifyOverdue()}
              disabled={notifySending || !overduePreview || overduePreview.eligible.length === 0}
            >
              {notifySending
                ? 'A enviar...'
                : overduePreview && overduePreview.eligible.length > 0
                  ? `Enviar para ${overduePreview.eligible.length}`
                  : 'Sem destinatarios'}
            </Button>
          </>
        }
      >
        {overduePreview && (
          <div className="overdue-notify">
            <p className="overdue-notify-summary">
              <strong>{overduePreview.total}</strong>{' '}
              {overduePreview.noticeType === 'suspension'
                ? `pagamento(s) com ${whatsappSuspensionNoticeDays}+ dias de atraso. `
                : 'pagamento(s) em atraso. '}
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
                      <small className="entity-code">{row.clientCode}</small>
                      <strong>{row.clientName}</strong>
                      <small>{row.phone}</small>
                    </div>
                    <Badge tone="danger">{row.daysOverdue}d</Badge>
                    <span className="overdue-notify-amount">{formatCve(row.amountCve)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                size="sm"
                icon={Send}
                title="Sem clientes elegíveis"
                description="Não há cobranças em atraso com telefone WhatsApp válido para envio em massa."
              />
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
        open={!!reversePreview}
        onClose={closeReversePreview}
        eyebrow="Reverter geracao"
        title={reversePreview ? `Mensalidades de ${reversePreview.referenceMonth}` : 'Reverter mensalidades'}
        size="md"
        closeOnBackdrop={!reverseSubmitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeReversePreview} disabled={reverseSubmitting}>Cancelar</Button>
            <Button
              onClick={() => void confirmReverseMonthly()}
              disabled={reverseSubmitting || !reversePreview || reversePreview.eligibleCount === 0}
            >
              {reverseSubmitting
                ? 'A reverter...'
                : reversePreview && reversePreview.eligibleCount > 0
                  ? `Reverter ${reversePreview.eligibleCount} cobranca(s)`
                  : 'Nada a reverter'}
            </Button>
          </>
        }
      >
        {reversePreview && (
          <div className="overdue-notify">
            <p className="overdue-notify-summary">
              <strong>{reversePreview.total}</strong> cobranca(s) em {reversePreview.referenceMonth}.{' '}
              <strong>{reversePreview.eligibleCount}</strong> serao apagadas ({formatCve(reversePreview.totalCve)}).{' '}
              {reversePreview.paidLockedCount > 0 && (
                <span className="overdue-notify-skip">
                  {reversePreview.paidLockedCount} pagas ficam intactas (anular se necessario).
                </span>
              )}
              {reversePreview.cancelledCount > 0 && (
                <span className="overdue-notify-skip">
                  {' '}{reversePreview.cancelledCount} ja anuladas.
                </span>
              )}
            </p>

            {reversePreview.eligibleCount > 0 ? (
              <ul className="overdue-notify-list">
                {reversePreview.eligible.map((row) => (
                  <li key={row.id}>
                    <div className="overdue-notify-meta">
                      <small className="entity-code">{row.clientCode || '—'}</small>
                      <strong>{row.clientName}</strong>
                      <small>FT {row.invoiceNumber || '-'} · venc. {row.dueDate}</small>
                    </div>
                    <Badge tone={row.status === 'overdue' ? 'danger' : 'info'}>{row.status}</Badge>
                    <span className="overdue-notify-amount">{formatCve(row.amountCve)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Message>
                Sem cobrancas pendentes ou em atraso para reverter em {reversePreview.referenceMonth}.
              </Message>
            )}

            {reversePreview.paidLockedCount > 0 && (
              <details className="overdue-notify-skipped">
                <summary>Pagas ({reversePreview.paidLockedCount}) - nao serao apagadas</summary>
                <ul>
                  {reversePreview.paidLocked.map((row) => (
                    <li key={row.id}>
                      {row.clientName} <small>(FT {row.invoiceNumber || '-'} - {formatCve(row.amountCve)})</small>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!individualRevert}
        onClose={closeIndividualRevert}
        eyebrow="Reverter cobranca"
        title={individualRevert ? `${individualRevert.clientName} - ${individualRevert.referenceMonth}` : 'Reverter cobranca'}
        size="sm"
        closeOnBackdrop={!individualRevertSubmitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeIndividualRevert} disabled={individualRevertSubmitting}>Cancelar</Button>
            <Button
              onClick={() => void confirmIndividualRevert()}
              disabled={individualRevertSubmitting}
            >
              {individualRevertSubmitting ? 'A reverter...' : 'Confirmar reversao'}
            </Button>
          </>
        }
      >
        {individualRevert && (
          <div className="overdue-notify">
            <p className="overdue-notify-summary">
              Vai apagar a cobranca <strong>FT {individualRevert.invoiceNumber || individualRevert.id}</strong>{' '}
              de <strong>{individualRevert.clientName}</strong> ({formatCve(individualRevert.amountCve)}).
              Esta accao nao pode ser desfeita. Se a cobranca foi enviada ao cliente, considere anular em vez de reverter.
            </p>
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
            <Button variant="secondary" onClick={closePdfPreview}>Fechar</Button>
            {pdfPreview && (
              <Button
                leadingIcon={<Download size={14} aria-hidden />}
                onClick={() => downloadPdf(pdfPreview.payment, pdfPreview.type)}
              >
                Descarregar
              </Button>
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
