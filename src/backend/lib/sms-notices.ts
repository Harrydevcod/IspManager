import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { readSecret } from './secrets';
import { enqueueSmsNotification } from './sms-outbox';
import { loadFunnel, loadOverdueCandidates, stageFor, type NoticeType, type OverdueCandidate } from './notices';
import { autoSuspensionGraceDays } from './auto-suspension';
import { whatsappChannelActive } from './whatsapp-provider';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate,
  normalizeSmsPhone,
  renderSmsTemplate,
  type SmsEventType
} from '../../shared/sms';
import { businessDay, businessHour, cutDate, NOTICE_SEND_FROM_HOUR } from '../../shared/business-day';

const LAST_RUN_KEY = 'lastSmsOverdueNoticesDate';
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

/** Ligado e com o telemóvel pareado: só assim algum SMS sai. */
export function smsChannelActive(db: Database.Database = getSqliteDatabase()): boolean {
  return getSetting('smsCompanionEnabled') === 'true'
    && Boolean(getSetting('smsCompanionBaseUrl'))
    && Boolean(readSecret(db, 'smsCompanionPairingKey'));
}

/** Cheap pre-check for the hourly timer: true when today's run hasn't happened. */
export function smsOverdueNoticesDueToday(now: Date = new Date()): boolean {
  return getSetting('smsAutoNoticesEnabled') === 'true'
    && getSetting(LAST_RUN_KEY) !== businessDay(now)
    && businessHour(now) >= NOTICE_SEND_FROM_HOUR;
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

type SmsNoticeContext = {
  graceDays: number;
  cooldownDays: number;
  companyName: string;
  today: string;
};

function noticeContext(now: Date): SmsNoticeContext {
  return {
    graceDays: autoSuspensionGraceDays(getSqliteDatabase()),
    cooldownDays: Number(getSetting('noticeCooldownDays')) || DEFAULT_COOLDOWN_DAYS,
    companyName: getSetting('companyName') || 'ISPM',
    today: businessDay(now)
  };
}

/**
 * Enfileira o SMS de uma etapa do funil para uma fatura. Devolve false quando
 * não há modelo para a etapa, o telefone não serve, o cliente recusou avisos,
 * ou já há um SMS do mesmo tipo vivo dentro de `noticeCooldownDays` (cobre os
 * envios manuais).
 */
function enqueueStageSms(row: OverdueCandidate, stage: NoticeType, ctx: SmsNoticeContext): boolean {
  const eventType = smsEventForStage(stage);
  const toPhone = normalizeSmsPhone(row.phone || '');
  if (!eventType || !toPhone || row.whatsappOptOut) return false;
  const alreadyQueued = getSqliteDatabase().prepare(`
    SELECT 1 FROM sms_outbox
    WHERE payment_id = ? AND event_type = ?
      AND status NOT IN ('failed','rejected','cancelled')
      AND created_at >= datetime('now', ?)
    LIMIT 1
  `).get(row.paymentId, eventType, `-${ctx.cooldownDays} days`);
  if (alreadyQueued) return false;

  const body = renderSmsTemplate(smsTemplateFor(eventType), {
    fullName: row.clientName,
    clientCode: row.clientCode,
    phone: toPhone,
    amountCve: row.amountCve,
    dueDate: row.dueDate,
    referenceMonth: row.referenceMonth,
    invoiceNumber: row.invoiceNumber,
    daysOverdue: Math.max(0, row.daysOverdue),
    suspensionDays: ctx.graceDays + 1,
    suspensionDate: cutDate(row.dueDate, ctx.graceDays, ctx.today),
    paymentLink: row.paymentLink
  }, ctx.companyName);
  enqueueSmsNotification({ clientId: row.clientId, paymentId: row.paymentId, eventType, toPhone, body });
  return true;
}

/**
 * O aviso desta fatura e etapa já está a caminho do cliente por WhatsApp
 * (entregue, enviado ou em fila) dentro do período de espera. Falhado ou
 * cancelado não conta: aí o SMS é o recurso.
 */
function whatsappCovers(paymentId: number, stage: NoticeType, cooldownDays: number): boolean {
  return Boolean(getSqliteDatabase().prepare(`
    SELECT 1 FROM whatsapp_notices n
    JOIN whatsapp_outbox o ON o.id = n.outbox_id
    WHERE n.payment_id = ? AND n.notice_type = ?
      AND n.sent_at >= datetime('now', ?)
      AND o.status NOT IN ('failed', 'cancelled')
    LIMIT 1
  `).get(paymentId, stage, `-${cooldownDays} days`));
}

/**
 * SMS do funil de cobrança, como recurso do WhatsApp: sai para a fatura cujo
 * aviso não está a caminho por WhatsApp (canal desligado ou por configurar,
 * mensagem falhada, ou nenhuma). Corre uma vez por dia, a partir das 08:00 de
 * Cabo Verde, só com `smsAutoNoticesEnabled` ligado e o telemóvel pareado, e
 * depois do job do WhatsApp (ver `server.ts`). Cada SMS chega ao telemóvel como
 * pedido a aprovar (o operador usa "Aprovar todos").
 *
 * `whatsapp_opt_out` também exclui: é a única recusa de avisos que existe.
 */
export function runSmsOverdueNoticesIfDue(now: Date = new Date()): SmsOverdueNoticesRun {
  if (getSetting('smsAutoNoticesEnabled') !== 'true') {
    return { skipped: true, reason: 'avisos automaticos por SMS desativados' };
  }
  const db = getSqliteDatabase();
  if (!smsChannelActive(db)) {
    return { skipped: true, reason: 'telemovel SMS nao pareado' };
  }

  const ctx = noticeContext(now);
  if (getSetting(LAST_RUN_KEY) === ctx.today) {
    return { skipped: true, reason: `avisos SMS de ${ctx.today} ja executados` };
  }
  if (businessHour(now) < NOTICE_SEND_FROM_HOUR) {
    return { skipped: true, reason: `avisos so a partir das ${NOTICE_SEND_FROM_HOUR}:00` };
  }

  const funnel = loadFunnel();
  const reminderWindow = Math.max(0, -funnel[0].threshold);
  const whatsappOn = whatsappChannelActive(db);

  let enqueued = 0;
  let skipped = 0;
  for (const row of loadOverdueCandidates(reminderWindow)) {
    const stage = stageFor(funnel, row.daysOverdue);
    if (!stage || (whatsappOn && whatsappCovers(row.paymentId, stage, ctx.cooldownDays))) { skipped += 1; continue; }
    if (enqueueStageSms(row, stage, ctx)) enqueued += 1;
    else skipped += 1;
  }

  writeSetting(LAST_RUN_KEY, ctx.today);
  return { ran: true, date: ctx.today, enqueued, skipped };
}

/**
 * Recurso imediato: um aviso automático de cobrança cuja mensagem de WhatsApp
 * falhou de vez passa a SMS logo, se o canal SMS estiver ativo e a fatura ainda
 * estiver em aberto. Nunca lança: a fila do WhatsApp não pode parar por isto.
 */
export function enqueueSmsFallbackForWhatsapp(outboxId: number, now: Date = new Date()): boolean {
  try {
    const db = getSqliteDatabase();
    const notice = db.prepare(`
      SELECT payment_id AS paymentId, notice_type AS stage FROM whatsapp_notices WHERE outbox_id = ? LIMIT 1
    `).get(outboxId) as { paymentId: number; stage: NoticeType } | undefined;
    if (!notice || !smsChannelActive(db)) return false;
    const funnel = loadFunnel();
    const row = loadOverdueCandidates(Math.max(0, -funnel[0].threshold)).find((c) => c.paymentId === notice.paymentId);
    if (!row) return false;
    return enqueueStageSms(row, notice.stage, noticeContext(now));
  } catch {
    return false;
  }
}
