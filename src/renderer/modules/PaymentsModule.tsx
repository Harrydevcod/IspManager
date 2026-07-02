import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw, Send } from 'lucide-react';
import { BulkActionBar, Button, ErrorRetry, Field, FilterBar, Message, PaginationControls, Select, SkeletonList, useConfirm, useToast } from '../components';
import { formatPtMonth } from '../lib/format';
import { authFetch } from '../lib/auth';
import { downloadAuthenticated, printAuthenticated, useAuthenticatedObjectUrl } from '../lib/download';
import { compareNumber, compareText, paginateRows, sortRows, type SortState } from '../lib/listView';
import { runBulk, summarizeBulk } from '../lib/bulkRun';
import { useRowSelection } from '../lib/useRowSelection';
import { defaultPostpaidReferenceMonth } from '../../shared/billing-period';
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
import type { PaymentRow, SmsEventType } from '../types';
import { IndividualRevertDialog } from './payments/IndividualRevertDialog';
import { PaymentDetailDialog, type PaymentActionMode, type PaymentMethod } from './payments/PaymentDetailDialog';
import { PaymentsList } from './payments/PaymentsList';
import { MonthlyBillingPreview, type BillingPreview } from './payments/MonthlyBillingPreview';
import { OverdueNotifyDialog, type OverdueNotifyPreview, type WhatsappNoticeType } from './payments/OverdueNotifyDialog';
import { PaymentsTotals } from './payments/PaymentsTotals';
import { PdfPreviewDialog } from './payments/PdfPreviewDialog';
import { ReverseMonthlyDialog, type ReverseMonthlyPreview } from './payments/ReverseMonthlyDialog';
import { BulkPaymentDialog, type BulkPaymentMode } from './payments/BulkPaymentDialog';

// ---------------------------------------------------------------------------
// Payment-private types (local to this module)
// ---------------------------------------------------------------------------

type PaymentSortKey = 'dueDate' | 'clientName' | 'status' | 'amountCve';
const DEFAULT_PAYMENT_SORT: SortState<PaymentSortKey> = { key: 'dueDate', direction: 'asc' };
const DEFAULT_PAYMENT_PAGE_SIZE = 25;

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
// PaymentsModule
// ---------------------------------------------------------------------------

export function PaymentsModule({
  focusStatus,
  onFocusHandled
}: {
  focusStatus?: 'overdue' | 'pending' | null;
  onFocusHandled?: () => void;
} = {}) {
  // Competência por defeito = mês fechado: criada no início do mês → mês anterior;
  // a partir do dia 30 → o mês que está a fechar (mesma regra da auto-faturação).
  const defaultRefMonth = defaultPostpaidReferenceMonth();
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [referenceMonth, setReferenceMonth] = useState(defaultRefMonth);
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
  const [reversePreview, setReversePreview] = useState<ReverseMonthlyPreview | null>(null);
  const [reverseLoading, setReverseLoading] = useState(false);
  const [reverseSubmitting, setReverseSubmitting] = useState(false);
  const [individualRevert, setIndividualRevert] = useState<PaymentRow | null>(null);
  const [individualRevertSubmitting, setIndividualRevertSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [sortState, setSortState] = useState<SortState<PaymentSortKey>>(DEFAULT_PAYMENT_SORT);
  const [paymentPage, setPaymentPage] = useState(1);
  const [paymentPageSize, setPaymentPageSize] = useState(DEFAULT_PAYMENT_PAGE_SIZE);
  const [pdfPreview, setPdfPreview] = useState<{ payment: PaymentRow; type: 'invoice' | 'receipt' } | null>(null);
  const [overduePreview, setOverduePreview] = useState<OverdueNotifyPreview | null>(null);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifySending, setNotifySending] = useState(false);
  const [bulkMode, setBulkMode] = useState<BulkPaymentMode | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const selection = useRowSelection<number>();
  const { toast } = useToast();
  const confirm = useConfirm();

  // Atalho vindo do Dashboard: foca o estado pedido (atraso varre todos os meses).
  useEffect(() => {
    if (!focusStatus) return;
    setStatusFilter(focusStatus);
    if (focusStatus === 'overdue') setShowAllMonths(true);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [companyName, setCompanyName] = useState('ISPM');
  const [whatsappTemplate, setWhatsappTemplate] = useState(fallbackWhatsappTemplate);
  const [whatsappInvoiceReadyTemplate, setWhatsappInvoiceReadyTemplate] = useState(fallbackWhatsappInvoiceReadyTemplate);
  const [whatsappReceiptTemplate, setWhatsappReceiptTemplate] = useState(fallbackWhatsappReceiptTemplate);
  const [whatsappOverdueTemplate, setWhatsappOverdueTemplate] = useState(fallbackWhatsappOverdueTemplate);
  const [whatsappSuspensionTemplate, setWhatsappSuspensionTemplate] = useState(fallbackWhatsappSuspensionTemplate);
  const [whatsappSuspensionNoticeDays, setWhatsappSuspensionNoticeDays] = useState(15);
  const [whatsappTick, setWhatsappTick] = useState(0);

  const loadPayments = useCallback(() => {
    setLoading(true);
    return authFetch('http://127.0.0.1:3001/api/payments')
      .then((response) => response.json() as Promise<PaymentRow[]>)
      .then((data) => {
        setPayments(data);
        setLoadError(null);
        return data;
      })
      .catch(() => {
        setPayments([]);
        setLoadError('Não foi possível carregar os pagamentos.');
        return [];
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

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
  }

  function openCancelForm(payment: PaymentRow) {
    setSelectedPayment(payment);
    setActionMode('cancel');
    setActionPaymentId(payment.id);
    setCancelReason('');
  }

  function openWhatsappForm(payment: PaymentRow) {
    setSelectedPayment(payment);
    setActionMode('whatsapp');
    setActionPaymentId(payment.id);
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

  async function sendDocumentWhatsapp(payment: PaymentRow, kind: 'invoice' | 'receipt') {
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${payment.id}/whatsapp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind })
      });
      const data = await response.json().catch(() => ({})) as { error?: string; status?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Nao foi possivel enviar o documento por WhatsApp.');
      }
      const doc = kind === 'invoice' ? 'Fatura' : 'Recibo';
      const verb = data.status === 'sent' ? 'enviado' : 'em fila para envio';
      const successMessage = `${doc} ${verb} por WhatsApp para ${payment.clientName}.`;
      setMessage(successMessage);
      toast(successMessage, 'success');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Nao foi possivel enviar o documento por WhatsApp.';
      setMessage(errorMessage);
      toast(errorMessage, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function sendPaymentSms(payment: PaymentRow, eventType: SmsEventType) {
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${payment.id}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType })
      });
      const data = await response.json().catch(() => ({})) as { error?: string; status?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Nao foi possivel enfileirar o SMS.');
      }
      const successMessage = `SMS criado e a aguardar aprovacao no Android para ${payment.clientName}.`;
      setMessage(successMessage);
      toast(successMessage, 'success');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Nao foi possivel enfileirar o SMS.';
      setMessage(errorMessage);
      toast(errorMessage, 'error');
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
      toast(`Revertidas ${result.reversed || 0} cobranca(s) de ${formatPtMonth(reversePreview.referenceMonth)}.`, 'success');
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
      toast(`Cobranca de ${individualRevert.clientName} (${formatPtMonth(individualRevert.referenceMonth)}) revertida.`, 'success');
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

  async function regenerateMonthlyPayment(payment: PaymentRow) {
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${payment.id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json().catch(() => ({})) as { id?: number; error?: string };
      if (!response.ok || !result.id) {
        toast(result.error || 'Nao foi possivel regenerar a mensalidade.', 'error');
        return;
      }
      const refreshedPayments = await loadPayments();
      const fresh = refreshedPayments.find((item) => item.id === result.id) || null;
      setSelectedPayment(fresh);
      closeActionForm();
      toast(`Mensalidade de ${payment.clientName} (${formatPtMonth(payment.referenceMonth)}) regenerada.`, 'success');
    } catch {
      toast('Falha de rede ao regenerar mensalidade.', 'error');
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

  // --- Ações em massa (selecionadas na lista) -----------------------------
  function selectedPaymentRows() {
    return visiblePayments.filter((payment) => selection.isSelected(payment.id));
  }

  async function runBulkNotify() {
    const targets = selectedPaymentRows().filter(
      (payment) => payment.status !== 'paid' && payment.status !== 'cancelled' && normalizeWhatsappPhone(payment.clientPhone)
    );
    if (targets.length === 0) {
      toast('Nenhuma cobrança selecionada com telefone válido para notificar.', 'error');
      return;
    }
    if (!(await confirm({
      title: `Notificar ${targets.length} cliente(s) por WhatsApp?`,
      message: 'Envia o lembrete de cobrança a cada cliente selecionado com telefone válido.',
      confirmLabel: 'Enviar'
    }))) return;
    setBulkSubmitting(true);
    try {
      const result = await runBulk(targets, async (payment) => {
        await sendWhatsappViaUltraMsg(payment.clientPhone, whatsappMessageFor(payment));
        markReminderSent(payment.id);
      });
      setWhatsappTick((tick) => tick + 1);
      toast(summarizeBulk(result, 'notificados'), result.failed ? 'info' : 'success');
      selection.clear();
    } finally {
      setBulkSubmitting(false);
    }
  }

  async function confirmBulkPay(method: PaymentMethod, date: string) {
    const targets = selectedPaymentRows().filter((payment) => payment.status === 'pending' || payment.status === 'overdue');
    if (targets.length === 0) {
      toast('Nenhuma cobrança selecionada por liquidar.', 'error');
      setBulkMode(null);
      return;
    }
    setBulkSubmitting(true);
    try {
      const result = await runBulk(targets, async (payment) => {
        const response = await authFetch(`http://127.0.0.1:3001/api/payments/${payment.id}/pay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentMethod: method, paymentDate: date })
        });
        if (!response.ok) throw new Error('pay failed');
      });
      toast(summarizeBulk(result, 'pagamentos registados'), result.failed ? 'info' : 'success');
      setBulkMode(null);
      selection.clear();
      await loadPayments();
    } finally {
      setBulkSubmitting(false);
    }
  }

  async function confirmBulkCancel(reason: string) {
    const targets = selectedPaymentRows().filter((payment) => payment.status !== 'cancelled');
    if (targets.length === 0) {
      toast('Nenhuma cobrança selecionada para anular.', 'error');
      setBulkMode(null);
      return;
    }
    setBulkSubmitting(true);
    try {
      const result = await runBulk(targets, async (payment) => {
        const response = await authFetch(`http://127.0.0.1:3001/api/payments/${payment.id}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        if (!response.ok) throw new Error('cancel failed');
      });
      toast(summarizeBulk(result, 'cobranças anuladas'), result.failed ? 'info' : 'success');
      setBulkMode(null);
      selection.clear();
      await loadPayments();
    } finally {
      setBulkSubmitting(false);
    }
  }

  // Endpoint do documento — o token NUNCA vai na URL; o header de auth é
  // injetado pelo authFetch (download) ou pelo useAuthenticatedObjectUrl (iframe).
  function documentEndpoint(paymentId: number, type: 'invoice' | 'receipt', inline = false) {
    const suffix = type === 'invoice' ? 'invoice.pdf' : 'receipt.pdf';
    return `http://127.0.0.1:3001/api/payments/${paymentId}/${suffix}${inline ? '?inline=1' : ''}`;
  }

  function documentNumber(payment: PaymentRow, type: 'invoice' | 'receipt') {
    return type === 'invoice' ? payment.invoiceNumber : payment.receiptNumber;
  }

  const refreshPaymentAfterDocumentIssue = useCallback(async (paymentId: number) => {
    const refreshedPayments = await loadPayments();
    const fresh = refreshedPayments.find((item) => item.id === paymentId) || null;
    if (!fresh) return null;

    setSelectedPayment((current) => current?.id === paymentId ? fresh : current);
    setPdfPreview((current) => current?.payment.id === paymentId ? { ...current, payment: fresh } : current);
    return fresh;
  }, [loadPayments]);

  async function downloadPdf(payment: PaymentRow, type: 'invoice' | 'receipt') {
    const docLabel = type === 'invoice' ? 'Fatura' : 'Recibo';
    const number = documentNumber(payment, type);
    try {
      const fallbackName = `${docLabel} - ${payment.clientName} - ${number || payment.id}.pdf`;
      const result = await downloadAuthenticated(documentEndpoint(payment.id, type), fallbackName);
      if (result.canceled) return;
      const fresh = await refreshPaymentAfterDocumentIssue(payment.id);
      const freshNumber = fresh ? documentNumber(fresh, type) : number;
      const ref = freshNumber || result.filename || `${docLabel} #${payment.id}`;
      toast(`${ref} guardado.`, 'success');
    } catch {
      toast(`Nao foi possivel descarregar o ${docLabel.toLowerCase()}.`, 'error');
    }
  }

  async function printPdf(payment: PaymentRow, type: 'invoice' | 'receipt') {
    const docLabel = type === 'invoice' ? 'fatura' : 'recibo';
    try {
      const result = await printAuthenticated(documentEndpoint(payment.id, type, true));
      if (result.canceled) return;
      await refreshPaymentAfterDocumentIssue(payment.id);
      toast(`${docLabel === 'fatura' ? 'Fatura' : 'Recibo'} enviado para impressao.`, 'success');
    } catch {
      toast(`Nao foi possivel imprimir o ${docLabel}.`, 'error');
    }
  }

  function previewPaymentDocument(payment: PaymentRow) {
    setSelectedPayment(payment);
    closeActionForm();
  }

  const normalizedSearch = search.trim().toLowerCase();
  const filteredPayments = useMemo(() => payments.filter((payment) => {
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
    }), [payments, normalizedSearch, referenceMonth, showAllMonths, statusFilter]);
  const visiblePayments = useMemo(() => sortRows(filteredPayments, sortState, {
    dueDate: (a, b) => a.dueDate.localeCompare(b.dueDate) || compareText(a.clientName, b.clientName),
    clientName: (a, b) => compareText(a.clientName, b.clientName) || a.dueDate.localeCompare(b.dueDate),
    status: (a, b) => compareText(a.status, b.status) || a.dueDate.localeCompare(b.dueDate),
    amountCve: (a, b) => compareNumber(a.amountCve, b.amountCve) || a.dueDate.localeCompare(b.dueDate)
  }), [filteredPayments, sortState]);
  const pagedPayments = useMemo(
    () => paginateRows(visiblePayments, { page: paymentPage, pageSize: paymentPageSize }),
    [paymentPage, paymentPageSize, visiblePayments]
  );

  useEffect(() => {
    setPaymentPage(1);
  }, [normalizedSearch, referenceMonth, showAllMonths, statusFilter, sortState, paymentPageSize]);

  // Mantém a seleção em massa restrita ao que está visível no filtro atual.
  const visibleIds = useMemo(() => visiblePayments.map((payment) => payment.id), [visiblePayments]);
  useEffect(() => { selection.retain(visibleIds); }, [visibleIds, selection]);
  const pageIds = useMemo(() => pagedPayments.rows.map((payment) => payment.id), [pagedPayments]);
  const tableSelection = {
    isSelected: (key: string | number) => selection.isSelected(Number(key)),
    onToggleRow: (key: string | number) => selection.toggle(Number(key)),
    headerState: selection.visibleState(pageIds),
    onToggleAll: () => selection.toggleVisible(pageIds)
  };

  const previewPayment = selectedPayment || pagedPayments.rows[0] || null;
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

  // Pago → o documento é o recibo emitido; pendente/atraso → a fatura.
  const previewDocType: 'invoice' | 'receipt' = selectedPayment?.status === 'paid' ? 'receipt' : 'invoice';
  const previewDoc = useAuthenticatedObjectUrl(
    selectedPayment && selectedPayment.status !== 'cancelled'
      ? documentEndpoint(selectedPayment.id, previewDocType, true)
      : null
  );
  const pdfDialogDoc = useAuthenticatedObjectUrl(
    pdfPreview ? documentEndpoint(pdfPreview.payment.id, pdfPreview.type, true) : null
  );
  const selectedPaymentId = selectedPayment?.id ?? null;
  const selectedPaymentStatus = selectedPayment?.status ?? null;
  const pdfPreviewPaymentId = pdfPreview?.payment.id ?? null;
  const previewDocNumber = selectedPayment ? documentNumber(selectedPayment, previewDocType) : null;
  const pdfDialogDocNumber = pdfPreview ? documentNumber(pdfPreview.payment, pdfPreview.type) : null;

  useEffect(() => {
    if (!selectedPaymentId || selectedPaymentStatus === 'cancelled' || previewDoc.error || !previewDoc.objectUrl || previewDocNumber) return;
    void refreshPaymentAfterDocumentIssue(selectedPaymentId);
  }, [previewDoc.objectUrl, previewDoc.error, previewDocNumber, selectedPaymentId, selectedPaymentStatus, refreshPaymentAfterDocumentIssue]);

  useEffect(() => {
    if (!pdfPreviewPaymentId || pdfDialogDoc.error || !pdfDialogDoc.objectUrl || pdfDialogDocNumber) return;
    void refreshPaymentAfterDocumentIssue(pdfPreviewPaymentId);
  }, [pdfDialogDoc.objectUrl, pdfDialogDoc.error, pdfDialogDocNumber, pdfPreviewPaymentId, refreshPaymentAfterDocumentIssue]);

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
        <Button variant="secondary" onClick={() => setShowAllMonths((current) => !current)} className={showAllMonths ? 'active' : ''}>
          {showAllMonths ? 'Mês atual' : 'Todos os meses'}
        </Button>
        <Button variant="secondary" onClick={() => {
          setStatusFilter('all');
          setReferenceMonth(defaultRefMonth);
          setShowAllMonths(false);
          setSearch('');
          setSortState(DEFAULT_PAYMENT_SORT);
          setPaymentPage(1);
        }}>
          Limpar filtros
        </Button>
        <small>{visiblePayments.length} cobrancas{showAllMonths ? ' (todos os meses)' : ` em ${formatPtMonth(referenceMonth)}`}</small>
      </FilterBar>

      <PaymentsTotals totals={totals} />

      {monthlyPreview && (
        <MonthlyBillingPreview
          preview={monthlyPreview}
          loading={monthlyLoading}
          onConfirm={() => void confirmMonthlyGenerate()}
          onClose={closeMonthlyPreview}
        />
      )}

      {selectedPayment && (
        <PaymentDetailDialog
          payment={selectedPayment}
          submitting={submitting}
          actionMode={actionMode}
          showActionForm={showActionForm}
          payMethod={payMethod}
          payDate={payDate}
          cancelReason={cancelReason}
          previewDoc={previewDoc}
          previewDocType={previewDocType}
          whatsappMessage={whatsappMessageFor(selectedPayment)}
          reminderSentToday={wasReminderSentToday(selectedPayment.id)}
          onClose={() => { setSelectedPayment(null); closeActionForm(); }}
          onOpenPdf={openPdf}
          onDownloadPdf={(payment, type) => void downloadPdf(payment, type)}
          onPrintPdf={(payment, type) => void printPdf(payment, type)}
          onSendDocumentWhatsapp={(payment, kind) => void sendDocumentWhatsapp(payment, kind)}
          onOpenPayForm={openPayForm}
          onOpenWhatsappForm={openWhatsappForm}
          onOpenCancelForm={openCancelForm}
          onRegenerate={(payment) => void regenerateMonthlyPayment(payment)}
          onCloseActionForm={closeActionForm}
          onPayMethodChange={setPayMethod}
          onPayDateChange={setPayDate}
          onCancelReasonChange={setCancelReason}
          onSubmitPay={() => void submitPayment(selectedPayment.id, payMethod, payDate)}
          onSubmitCancel={() => void submitCancel(selectedPayment.id, cancelReason)}
          onSubmitWhatsapp={() => void submitWhatsapp(selectedPayment)}
        />
      )}

      {loadError && payments.length === 0 && <ErrorRetry message={loadError} onRetry={() => { void loadPayments(); }} />}

      {loading && payments.length === 0 ? (
        <SkeletonList rows={6} />
      ) : (
        <>
          <BulkActionBar count={selection.count} onClear={selection.clear} noun={{ one: 'cobrança selecionada', many: 'cobranças selecionadas' }}>
            <Button variant="secondary" size="sm" leadingIcon={<Send size={14} aria-hidden />} disabled={bulkSubmitting} onClick={() => void runBulkNotify()}>
              Notificar WhatsApp
            </Button>
            <Button variant="secondary" size="sm" disabled={bulkSubmitting} onClick={() => setBulkMode('pay')}>
              Registar pago
            </Button>
            <Button variant="danger" size="sm" disabled={bulkSubmitting} onClick={() => setBulkMode('cancel')}>
              Anular
            </Button>
          </BulkActionBar>

          <PaymentsList
            payments={pagedPayments.rows}
            activeId={previewPayment?.id ?? null}
            selection={tableSelection}
            sort={sortState}
            onSortChange={setSortState}
            submitting={submitting}
            isReminderSentToday={wasReminderSentToday}
            onPreview={previewPaymentDocument}
            onOpenPdf={openPdf}
            onMarkOverdue={(p) => void markOverdue(p)}
            onOpenPayForm={openPayForm}
            onOpenWhatsappForm={openWhatsappForm}
            onSendDocumentWhatsapp={(p, kind) => void sendDocumentWhatsapp(p, kind)}
            onSendSms={(p, eventType) => void sendPaymentSms(p, eventType)}
            onOpenCancelForm={openCancelForm}
            onRevert={openIndividualRevert}
            onRegenerate={(p) => void regenerateMonthlyPayment(p)}
          />

          <PaginationControls
            page={pagedPayments.page}
            pageSize={pagedPayments.pageSize}
            total={pagedPayments.total}
            totalPages={pagedPayments.totalPages}
            start={pagedPayments.start}
            end={pagedPayments.end}
            onPageChange={setPaymentPage}
            onPageSizeChange={setPaymentPageSize}
          />
        </>
      )}

      <OverdueNotifyDialog
        preview={overduePreview}
        suspensionNoticeDays={whatsappSuspensionNoticeDays}
        sending={notifySending}
        onClose={closeOverduePreview}
        onConfirm={() => void confirmNotifyOverdue()}
      />

      <ReverseMonthlyDialog
        preview={reversePreview}
        submitting={reverseSubmitting}
        onClose={closeReversePreview}
        onConfirm={() => void confirmReverseMonthly()}
      />

      <IndividualRevertDialog
        payment={individualRevert}
        submitting={individualRevertSubmitting}
        onClose={closeIndividualRevert}
        onConfirm={() => void confirmIndividualRevert()}
      />

      <PdfPreviewDialog
        preview={pdfPreview}
        document={pdfDialogDoc}
        onClose={closePdfPreview}
        onDownload={(payment, type) => void downloadPdf(payment, type)}
        onPrint={(payment, type) => void printPdf(payment, type)}
      />

      <BulkPaymentDialog
        mode={bulkMode}
        count={selection.count}
        submitting={bulkSubmitting}
        onClose={() => { if (!bulkSubmitting) setBulkMode(null); }}
        onConfirmPay={(method, date) => void confirmBulkPay(method, date)}
        onConfirmCancel={(reason) => void confirmBulkCancel(reason)}
      />
    </section>
  );
}
