import { getSqliteDatabase } from '../db/database';
import { readSecret } from './secrets';
import { enqueueSmsNotification } from './sms-outbox';
import { loadFunnel, loadOverdueCandidates, stageFor, type NoticeType } from './notices';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate,
  normalizeSmsPhone,
  renderSmsTemplate,
  type SmsEventType
} from '../../shared/sms';
import { businessDay } from '../../shared/business-day';

const LAST_RUN_KEY = 'lastSmsOverdueNoticesDate';
const DEFAULT_SUSPENSION_DAYS = 15;
const DEFAULT_COOLDOWN_DAYS = 7;

export type SmsOverdueNoticesRun =
  | { skipped: true; reason: string }
  | { ran: true; date: string; enqueued: number; skipped: number };

function getSetting(key: string): string {
  const row = getSqliteDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || '';
}

function writeSetting(key: string, value: string): void {
  getSqliteDatabase().prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

/** Cheap pre-check for the hourly timer: true when today's run hasn't happened. */
export function smsOverdueNoticesDueToday(now: Date = new Date()): boolean {
  return getSetting('smsAutoNoticesEnabled') === 'true' && getSetting(LAST_RUN_KEY) !== businessDay(now);
}

export function smsTemplateFor(eventType: SmsEventType): string {
  const keys: Record<SmsEventType, [string, string]> = {
    invoice_issued: ['smsInvoiceIssuedTemplate', fallbackSmsInvoiceIssuedTemplate],
    receipt_confirmed: ['smsReceiptConfirmedTemplate', fallbackSmsReceiptConfirmedTemplate],
    payment_overdue: ['smsPaymentOverdueTemplate', fallbackSmsPaymentOverdueTemplate],
    suspension_notice: ['smsSuspensionNoticeTemplate', fallbackSmsSuspensionNoticeTemplate]
  };
  const [key, fallback] = keys[eventType];
  return getSetting(key) || fallback;
}

/**
 * Etapa do funil → modelo de SMS. O lembrete antes do vencimento fica de fora:
 * não há modelo para ele e cada SMS gasta saldo do SIM.
 */
export function smsEventForStage(stage: NoticeType): SmsEventType | null {
  if (stage === 'overdue' || stage === 'warning') return 'payment_overdue';
  if (stage === 'suspension') return 'suspension_notice';
  return null;
}

/**
 * Reforço por SMS do funil de cobrança, para todos os clientes com telefone
 * válido. Corre uma vez por dia, só com `smsAutoNoticesEnabled` ligado e o
 * telemóvel pareado. Não depende do WhatsApp estar configurado. Cada SMS chega
 * ao telemóvel como pedido a aprovar (o operador usa "Aprovar todos").
 *
 * Anti-duplicado: salta a fatura se já houver, dentro de `noticeCooldownDays`,
 * um SMS do mesmo tipo que não falhou nem foi rejeitado (cobre os envios manuais).
 * `whatsapp_opt_out` também exclui: é a única recusa de avisos que existe.
 */
export function runSmsOverdueNoticesIfDue(now: Date = new Date()): SmsOverdueNoticesRun {
  if (getSetting('smsAutoNoticesEnabled') !== 'true') {
    return { skipped: true, reason: 'avisos automaticos por SMS desativados' };
  }
  const db = getSqliteDatabase();
  if (getSetting('smsCompanionEnabled') !== 'true' || !getSetting('smsCompanionBaseUrl') || !readSecret(db, 'smsCompanionPairingKey')) {
    return { skipped: true, reason: 'telemovel SMS nao pareado' };
  }

  const todayIso = businessDay(now);
  if (getSetting(LAST_RUN_KEY) === todayIso) {
    return { skipped: true, reason: `avisos SMS de ${todayIso} ja executados` };
  }

  const funnel = loadFunnel();
  const suspensionDays = Number(getSetting('whatsappSuspensionNoticeDays')) || DEFAULT_SUSPENSION_DAYS;
  const cooldownDays = Number(getSetting('noticeCooldownDays')) || DEFAULT_COOLDOWN_DAYS;
  const companyName = getSetting('companyName') || 'ISPM';
  const reminderWindow = Math.max(0, -funnel[0].threshold);

  const alreadyQueued = db.prepare(`
    SELECT 1 FROM sms_outbox
    WHERE payment_id = ? AND event_type = ?
      AND status NOT IN ('failed','rejected','cancelled')
      AND created_at >= datetime('now', ?)
    LIMIT 1
  `);

  let enqueued = 0;
  let skipped = 0;
  for (const row of loadOverdueCandidates(reminderWindow)) {
    const stage = stageFor(funnel, row.daysOverdue);
    const eventType = stage ? smsEventForStage(stage) : null;
    const toPhone = normalizeSmsPhone(row.phone || '');
    if (!eventType || !toPhone || row.whatsappOptOut) { skipped += 1; continue; }
    if (alreadyQueued.get(row.paymentId, eventType, `-${cooldownDays} days`)) { skipped += 1; continue; }

    const body = renderSmsTemplate(smsTemplateFor(eventType), {
      fullName: row.clientName,
      clientCode: row.clientCode,
      phone: toPhone,
      amountCve: row.amountCve,
      dueDate: row.dueDate,
      referenceMonth: row.referenceMonth,
      invoiceNumber: row.invoiceNumber,
      daysOverdue: Math.max(0, row.daysOverdue),
      suspensionDays,
      paymentLink: row.paymentLink
    }, companyName);
    enqueueSmsNotification({ clientId: row.clientId, paymentId: row.paymentId, eventType, toPhone, body });
    enqueued += 1;
  }

  writeSetting(LAST_RUN_KEY, todayIso);
  return { ran: true, date: todayIso, enqueued, skipped };
}
