import { getSqliteDatabase } from '../db/database';
import {
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  renderWhatsappTemplate
} from '../../shared/whatsapp';
import { normalizeUltraMsgPhone, sendViaUltraMsg, type UltraMsgSendResult } from './ultramsg';

const LAST_RUN_KEY = 'lastOverdueNoticesDate';
const DEFAULT_SUSPENSION_DAYS = 15;
const DEFAULT_COOLDOWN_DAYS = 7;
const SEND_INTERVAL_MS = 900;

type NoticeType = 'overdue' | 'suspension';

type OverdueCandidate = {
  paymentId: number;
  clientId: number;
  clientName: string;
  clientCode: string;
  phone: string | null;
  amountCve: number;
  dueDate: string;
  referenceMonth: string;
  invoiceNumber: string | null;
  daysOverdue: number;
  whatsappOptOut: number;
};

/** Sender seam — defaults to the real UltraMsg transport, injectable in tests. */
export type NoticeSender = (instanceId: string, token: string, to: string, body: string) => Promise<UltraMsgSendResult>;

export type OverdueNoticesRun =
  | { skipped: true; reason: string }
  | { ran: true; date: string; sent: number; failed: number; skipped: number };

function getSetting(key: string): string {
  const db = getSqliteDatabase();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value.trim() || '';
}

function writeSetting(key: string, value: string): void {
  const db = getSqliteDatabase();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function isEnabled(): boolean {
  const raw = getSetting('autoNoticesEnabled').toLowerCase();
  return raw === 'true' || raw === '1';
}

function templateFor(type: NoticeType): string {
  if (type === 'suspension') {
    return getSetting('whatsappSuspensionTemplate') || fallbackWhatsappSuspensionTemplate;
  }
  return getSetting('whatsappOverdueTemplate') || getSetting('whatsappTemplate') || fallbackWhatsappOverdueTemplate || fallbackWhatsappTemplate;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Automatic counterpart to the manual `notify-overdue` route: sends WhatsApp
 * overdue/suspension notices once per day, opt-in via the `autoNoticesEnabled`
 * setting (off by default — never message customers without explicit consent).
 *
 * Idempotent on two axes:
 *  - daily guard via `lastOverdueNoticesDate` (runs at most once per calendar day);
 *  - per-payment dedupe against `whatsapp_notices` inside the cooldown window,
 *    which also covers manual sends since the route logs there too.
 *
 * Notice type is derived per payment: `suspension` once it crosses the
 * configured day threshold, otherwise `overdue`. Safe to call on every boot.
 */
export async function runOverdueNoticesIfDue(
  now: Date = new Date(),
  send: NoticeSender = sendViaUltraMsg
): Promise<OverdueNoticesRun> {
  if (!isEnabled()) {
    return { skipped: true, reason: 'avisos automaticos desativados' };
  }

  const instanceId = getSetting('ultraMsgInstanceId');
  const token = getSetting('ultraMsgToken');
  if (!instanceId || !token) {
    return { skipped: true, reason: 'UltraMsg nao configurado' };
  }

  const todayIso = now.toISOString().slice(0, 10);
  if (getSetting(LAST_RUN_KEY) === todayIso) {
    return { skipped: true, reason: `avisos de ${todayIso} ja executados` };
  }

  const db = getSqliteDatabase();
  const suspensionDays = Number(getSetting('whatsappSuspensionNoticeDays')) || DEFAULT_SUSPENSION_DAYS;
  const cooldownDays = Number(getSetting('noticeCooldownDays')) || DEFAULT_COOLDOWN_DAYS;
  const companyName = getSetting('companyName') || 'ISPM';

  const candidates = db.prepare(`
    SELECT
      py.id AS paymentId,
      c.id AS clientId,
      c.full_name AS clientName,
      c.client_code AS clientCode,
      c.phone AS phone,
      c.whatsapp_opt_out AS whatsappOptOut,
      py.amount_cve AS amountCve,
      py.due_date AS dueDate,
      py.reference_month AS referenceMonth,
      py.invoice_number AS invoiceNumber,
      CAST(julianday('now') - julianday(py.due_date) AS INTEGER) AS daysOverdue
    FROM payments py
    JOIN clients c ON c.id = py.client_id
    WHERE (py.status = 'overdue'
           OR (py.status = 'pending' AND py.due_date < date('now')))
    ORDER BY py.due_date ASC
  `).all() as OverdueCandidate[];

  const recentlyNotified = db.prepare(`
    SELECT 1 FROM whatsapp_notices
    WHERE payment_id = ? AND notice_type = ? AND status = 'sent'
      AND sent_at >= datetime('now', ?)
    LIMIT 1
  `);
  const logNotice = db.prepare(`
    INSERT INTO whatsapp_notices (payment_id, client_id, notice_type, origin, phone, body, status, error)
    VALUES (?, ?, ?, 'auto', ?, ?, ?, ?)
  `);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  const eligible = candidates.filter((row) => {
    if (row.whatsappOptOut) { skipped += 1; return false; }
    if (!normalizeUltraMsgPhone(row.phone || '')) { skipped += 1; return false; }
    return true;
  });

  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i];
    const type: NoticeType = row.daysOverdue >= suspensionDays ? 'suspension' : 'overdue';

    const alreadySent = recentlyNotified.get(row.paymentId, type, `-${cooldownDays} days`);
    if (alreadySent) { skipped += 1; continue; }

    const to = normalizeUltraMsgPhone(row.phone || '');
    const body = renderWhatsappTemplate(
      templateFor(type),
      {
        fullName: row.clientName,
        clientCode: row.clientCode,
        phone: row.phone,
        amountCve: row.amountCve,
        dueDate: row.dueDate,
        referenceMonth: row.referenceMonth,
        invoiceNumber: row.invoiceNumber,
        daysOverdue: row.daysOverdue,
        suspensionDays
      },
      companyName
    );

    const result = await send(instanceId, token, to, body);
    if (result.ok) {
      sent += 1;
      logNotice.run(row.paymentId, row.clientId, type, to, body, 'sent', null);
    } else {
      failed += 1;
      logNotice.run(row.paymentId, row.clientId, type, to, body, 'failed', result.reason);
    }

    if (i < eligible.length - 1) {
      await delay(SEND_INTERVAL_MS);
    }
  }

  writeSetting(LAST_RUN_KEY, todayIso);
  return { ran: true, date: todayIso, sent, failed, skipped };
}
