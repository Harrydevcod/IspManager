import { getSqliteDatabase } from '../db/database';
import {
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReminderTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  fallbackWhatsappWarningTemplate,
  renderWhatsappTemplate
} from '../../shared/whatsapp';
import { normalizeUltraMsgPhone } from './ultramsg';
import { enqueueWhatsapp } from './whatsapp-outbox';

const LAST_RUN_KEY = 'lastOverdueNoticesDate';
const DEFAULT_REMINDER_DAYS = 3;
const DEFAULT_OVERDUE_DAYS = 1;
const DEFAULT_WARNING_DAYS = 7;
const DEFAULT_SUSPENSION_DAYS = 15;
const DEFAULT_COOLDOWN_DAYS = 7;

type NoticeType = 'reminder' | 'overdue' | 'warning' | 'suspension';

type FunnelStage = { stage: NoticeType; threshold: number };

/**
 * Funil de cobrança configurável, por dias relativos ao vencimento (negativo =
 * antes). Reutiliza `whatsappSuspensionNoticeDays` para a etapa de suspensão.
 * Devolve as etapas ordenadas por threshold crescente.
 */
function loadFunnel(): FunnelStage[] {
  const reminderDays = Number(getSetting('dunningReminderDays')) || DEFAULT_REMINDER_DAYS;
  const overdueDays = Number(getSetting('dunningOverdueDays')) || DEFAULT_OVERDUE_DAYS;
  const warningDays = Number(getSetting('dunningWarningDays')) || DEFAULT_WARNING_DAYS;
  const suspensionDays = Number(getSetting('whatsappSuspensionNoticeDays')) || DEFAULT_SUSPENSION_DAYS;
  const stages: FunnelStage[] = [
    { stage: 'reminder', threshold: -Math.abs(reminderDays) },
    { stage: 'overdue', threshold: overdueDays },
    { stage: 'warning', threshold: warningDays },
    { stage: 'suspension', threshold: suspensionDays }
  ];
  return stages.sort((a, b) => a.threshold - b.threshold);
}

/** Etapa atual = a de maior threshold <= dias de atraso; null se ainda cedo demais. */
function stageFor(funnel: FunnelStage[], daysOverdue: number): NoticeType | null {
  let current: NoticeType | null = null;
  for (const s of funnel) {
    if (s.threshold <= daysOverdue) current = s.stage;
  }
  return current;
}

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

export type OverdueNoticesRun =
  | { skipped: true; reason: string }
  | { ran: true; date: string; enqueued: number; skipped: number };

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
  switch (type) {
    case 'reminder':
      return getSetting('whatsappReminderTemplate') || fallbackWhatsappReminderTemplate;
    case 'warning':
      return getSetting('whatsappWarningTemplate') || fallbackWhatsappWarningTemplate;
    case 'suspension':
      return getSetting('whatsappSuspensionTemplate') || fallbackWhatsappSuspensionTemplate;
    default:
      return getSetting('whatsappOverdueTemplate') || getSetting('whatsappTemplate') || fallbackWhatsappOverdueTemplate || fallbackWhatsappTemplate;
  }
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
 * A etapa do funil é derivada por pagamento a partir dos dias de atraso
 * (`reminder` antes do vencimento → `overdue` → `warning` → `suspension`),
 * via {@link loadFunnel}/{@link stageFor}. Safe to call on every boot.
 */
export async function runOverdueNoticesIfDue(
  now: Date = new Date()
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
  const funnel = loadFunnel();
  const suspensionDays = Number(getSetting('whatsappSuspensionNoticeDays')) || DEFAULT_SUSPENSION_DAYS;
  const cooldownDays = Number(getSetting('noticeCooldownDays')) || DEFAULT_COOLDOWN_DAYS;
  const companyName = getSetting('companyName') || 'ISPM';
  // Janela de antecipação = etapa mais cedo do funil (reminder, threshold negativo).
  const reminderWindow = Math.max(0, -funnel[0].threshold);

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
           OR (py.status = 'pending' AND py.due_date <= date('now', '+' || ? || ' days')))
    ORDER BY py.due_date ASC
  `).all(reminderWindow) as OverdueCandidate[];

  const recentlyNotified = db.prepare(`
    SELECT 1 FROM whatsapp_notices
    WHERE payment_id = ? AND notice_type = ? AND status = 'sent'
      AND sent_at >= datetime('now', ?)
    LIMIT 1
  `);
  const logNotice = db.prepare(`
    INSERT INTO whatsapp_notices (payment_id, client_id, notice_type, origin, phone, body, status, error, outbox_id)
    VALUES (?, ?, ?, 'auto', ?, ?, 'sent', NULL, ?)
  `);

  let enqueued = 0;
  let skipped = 0;

  const eligible = candidates.filter((row) => {
    if (row.whatsappOptOut) { skipped += 1; return false; }
    if (!normalizeUltraMsgPhone(row.phone || '')) { skipped += 1; return false; }
    return true;
  });

  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i];
    const type = stageFor(funnel, row.daysOverdue);
    if (!type) { skipped += 1; continue; }

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

    const outboxId = enqueueWhatsapp({ toPhone: to, kind: 'text', body, clientId: row.clientId, origin: 'auto' });
    enqueued += 1;
    logNotice.run(row.paymentId, row.clientId, type, to, body, outboxId);
  }

  writeSetting(LAST_RUN_KEY, todayIso);
  return { ran: true, date: todayIso, enqueued, skipped };
}
