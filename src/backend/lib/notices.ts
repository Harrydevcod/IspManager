import { getSqliteDatabase } from '../db/database';
import { balanceSqlExpr } from './payments';
import { openPaymentLinkSql } from './vinti4';
import { planProtectedSql } from './payment-plans';
import { loadPaymentBehaviour } from './payment-behaviour';
import type { PaymentClass } from '../../shared/payment-score';
import {
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReminderTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  fallbackWhatsappWarningTemplate,
  renderWhatsappTemplate
} from '../../shared/whatsapp';
import { enqueueWhatsapp } from './whatsapp-outbox';
import { configuredWhatsappProviderLabel, normalizeWhatsappPhone, resolveWhatsappProvider, whatsappChannelEnabled } from './whatsapp-provider';
import { businessDay, businessHour, cutDate, NOTICE_SEND_FROM_HOUR, sqlBusinessDate } from '../../shared/business-day';
import { autoSuspensionGraceDays } from './auto-suspension';
import { SUSPENSION_NOTICE_LEAD_DAYS } from '../../shared/upcoming-suspension';
import { listMetaCloudTemplates } from './meta-cloud';
import { readSecret } from './secrets';
import { describePayments } from './payment-description';
import { prepareMetaTemplate } from './meta-template';
import type { WhatsappTemplate } from './whatsapp-provider';

const LAST_RUN_KEY = 'lastOverdueNoticesDate';
const DEFAULT_REMINDER_DAYS = 3;
const DEFAULT_OVERDUE_DAYS = 1;
const DEFAULT_WARNING_DAYS = 7;
const DEFAULT_COOLDOWN_DAYS = 7;

export type NoticeType = 'reminder' | 'overdue' | 'warning' | 'suspension';

export type FunnelStage = { stage: NoticeType; threshold: number };

/**
 * Funil de cobrança configurável, por dias relativos ao vencimento (negativo =
 * antes). A etapa de suspensão vem da tolerância do corte automático: começa
 * {@link SUSPENSION_NOTICE_LEAD_DAYS} dias antes do corte, nunca antes do aviso.
 * Devolve as etapas ordenadas por threshold crescente.
 */
export function loadFunnel(): FunnelStage[] {
  const reminderDays = Number(getSetting('dunningReminderDays')) || DEFAULT_REMINDER_DAYS;
  const overdueDays = Number(getSetting('dunningOverdueDays')) || DEFAULT_OVERDUE_DAYS;
  const warningDays = Number(getSetting('dunningWarningDays')) || DEFAULT_WARNING_DAYS;
  const suspensionDays = Math.max(warningDays, autoSuspensionGraceDays(getSqliteDatabase()) + 1 - SUSPENSION_NOTICE_LEAD_DAYS);
  const stages: FunnelStage[] = [
    { stage: 'reminder', threshold: -Math.abs(reminderDays) },
    { stage: 'overdue', threshold: overdueDays },
    { stage: 'warning', threshold: warningDays },
    { stage: 'suspension', threshold: suspensionDays }
  ];
  return stages.sort((a, b) => a.threshold - b.threshold);
}

/**
 * Quantos dias antes do vencimento se lembra um cliente, pela classe dele.
 *
 * Quem paga sempre a horas não precisa de ser lembrado — e um lembrete que não
 * muda nada é uma mensagem a mais na vida de quem já cumpre. Quem costuma
 * atrasar é avisado mais cedo, porque é onde o lembrete ainda muda o resultado.
 *
 * Sem letra vale o que está configurado: a um cliente que ainda não se conhece
 * não se tira nem se antecipa nada.
 *
 * `null` = não há lembrete antes do vencimento. As restantes etapas do funil
 * (vencido, aviso, suspensão) não mudam com a classe: essas obedecem ao
 * contrato, não ao histórico.
 */
export function reminderLeadFor(letter: PaymentClass | null, configured: number): number | null {
  if (letter === null) return configured;
  if (letter === 'A' || letter === 'B') return null;
  return letter === 'C' ? 3 : 5;
}

/** O funil deste cliente: só o lembrete muda, e só na antecedência. */
export function funnelForClass(base: FunnelStage[], letter: PaymentClass | null, configured: number): FunnelStage[] {
  const lead = reminderLeadFor(letter, configured);
  const semLembrete = base.filter((stage) => stage.stage !== 'reminder');
  if (lead === null) return semLembrete;
  return [...semLembrete, { stage: 'reminder' as const, threshold: -Math.abs(lead) }]
    .sort((a, b) => a.threshold - b.threshold);
}

/** Etapa atual = a de maior threshold <= dias de atraso; null se ainda cedo demais. */
export function stageFor(funnel: FunnelStage[], daysOverdue: number): NoticeType | null {
  let current: NoticeType | null = null;
  for (const s of funnel) {
    if (s.threshold <= daysOverdue) current = s.stage;
  }
  return current;
}

export type OverdueCandidate = {
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
  paymentLink: string | null;
  /** `{servico}` e `{mes}` (`describePayments`): o que a fatura cobra e de quando. */
  services: string;
  periodLabel: string;
};

/**
 * Faturas em aberto já vencidas, ou a vencer dentro de [reminderWindow] dias,
 * com o saldo em dívida. Fonte única para os avisos de WhatsApp e de SMS.
 * Ficam de fora as que estão num acordo de pagamento em dia.
 */
export function loadOverdueCandidates(reminderWindow: number): OverdueCandidate[] {
  const db = getSqliteDatabase();
  const rows = db.prepare(`
    SELECT
      py.id AS paymentId,
      c.id AS clientId,
      c.full_name AS clientName,
      c.client_code AS clientCode,
      c.phone AS phone,
      c.whatsapp_opt_out AS whatsappOptOut,
      -- Saldo, nao valor da fatura: o aviso automatico tem de pedir o que
      -- falta, senao vai cobrar duas vezes a quem ja pagou por conta.
      ${balanceSqlExpr('py')} AS amountCve,
      py.due_date AS dueDate,
      py.reference_month AS referenceMonth,
      py.invoice_number AS invoiceNumber,
      -- So as faturas que ja tem link de pagamento levam-no (ADR 0016, 0019).
      ${openPaymentLinkSql('py')} AS paymentLink,
      CAST(julianday('now') - julianday(py.due_date) AS INTEGER) AS daysOverdue
    FROM payments py
    JOIN clients c ON c.id = py.client_id
    WHERE c.system_kind IS NULL AND py.document_type = 'invoice'
      AND (py.status = 'overdue'
           OR (py.status = 'pending' AND py.due_date <= ${sqlBusinessDate("'+' || ? || ' days'")}))
      -- Acordo de pagamento em dia (0103): a cobrança dessas faturas é o calendário do acordo.
      AND ${planProtectedSql('py')}
    ORDER BY py.due_date ASC
  `).all(reminderWindow) as Array<Omit<OverdueCandidate, 'services' | 'periodLabel'>>;
  const described = describePayments(db, rows.map((row) => row.paymentId));
  return rows.map((row) => ({ ...row, services: described.get(row.paymentId)?.services ?? '', periodLabel: described.get(row.paymentId)?.period ?? '' }));
}

export type OverdueNoticesRun =
  | { skipped: true; reason: string }
  | { ran: true; date: string; enqueued: number; skipped: number; templateErrors?: Array<{ stage: NoticeType; reason: string }> };

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

/** Pré-verificação barata para o relógio de hora a hora: hoje ainda por correr, e já é hora. */
export function overdueNoticesDueToday(now: Date = new Date()): boolean {
  return isEnabled() && getSetting(LAST_RUN_KEY) !== businessDay(now) && businessHour(now) >= NOTICE_SEND_FROM_HOUR;
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

  if (!whatsappChannelEnabled(getSqliteDatabase())) {
    return { skipped: true, reason: 'canal WhatsApp desligado' };
  }
  const provider = resolveWhatsappProvider(getSqliteDatabase());
  if (!provider) {
    return { skipped: true, reason: `${configuredWhatsappProviderLabel(getSqliteDatabase())} nao configurado` };
  }

  const todayIso = businessDay(now);
  if (getSetting(LAST_RUN_KEY) === todayIso) {
    return { skipped: true, reason: `avisos de ${todayIso} ja executados` };
  }
  if (businessHour(now) < NOTICE_SEND_FROM_HOUR) {
    return { skipped: true, reason: `avisos so a partir das ${NOTICE_SEND_FROM_HOUR}:00` };
  }

  const db = getSqliteDatabase();
  const metaKeys: Record<NoticeType, string> = { reminder: 'metaTemplateReminder', overdue: 'metaTemplateOverdue', warning: 'metaTemplateWarning', suspension: 'metaTemplateSuspension' };
  const selections = Object.fromEntries(Object.entries(metaKeys).map(([stage, key]) => [stage, getSetting(key)])) as Record<NoticeType, string>;
  let approved: Array<{ name: string; language: string; body: string }> = [];
  if (provider.id === 'meta-cloud' && Object.values(selections).some(Boolean)) {
    const account = getSetting('metaBusinessAccountId');
    const token = readSecret(db, 'metaAccessToken');
    if (!/^\d{1,32}$/.test(account) || !token) return { skipped: true, reason: 'Conta WhatsApp Business nao configurada' };
    const result = await listMetaCloudTemplates(account, token);
    if (!result.ok) return { skipped: true, reason: result.reason };
    approved = result.templates;
  }
  const funnel = loadFunnel();
  const configuredLead = Math.max(0, -funnel[0].threshold);
  // A classe de cada cliente, lida uma vez por passagem: decide a antecedência
  // do lembrete, e nada mais do que isso.
  const classes = new Map(
    loadPaymentBehaviour(db).clients.map((client) => [client.clientId, client.letter])
  );
  const grace = autoSuspensionGraceDays(db);
  const cooldownDays = Number(getSetting('noticeCooldownDays')) || DEFAULT_COOLDOWN_DAYS;
  const companyName = getSetting('companyName') || 'ISPM';
  // Janela de antecipação = a maior antecedência possível, não a configurada:
  // um cliente de classe D é lembrado 5 dias antes mesmo que a definição diga 2,
  // e sem esta folga a fatura dele nem chegava a ser candidata.
  const reminderWindow = Math.max(configuredLead, 5);

  const candidates = loadOverdueCandidates(reminderWindow);

  const recentlyNotified = db.prepare(`
    SELECT 1 FROM whatsapp_notices n
    LEFT JOIN whatsapp_outbox o ON o.id = n.outbox_id
    WHERE n.payment_id = ? AND n.notice_type = ? AND n.status = 'sent'
      AND n.sent_at >= datetime('now', ?)
      -- Um aviso cuja mensagem falhou na fila não conta: não chegou ao cliente.
      AND COALESCE(o.status, 'sent') NOT IN ('failed', 'cancelled')
    LIMIT 1
  `);
  const logNotice = db.prepare(`
    INSERT INTO whatsapp_notices (payment_id, client_id, notice_type, origin, phone, body, status, error, outbox_id)
    VALUES (?, ?, ?, 'auto', ?, ?, 'sent', NULL, ?)
  `);

  let enqueued = 0;
  let skipped = 0;
  const templateErrors = new Map<NoticeType, string>();

  const eligible = candidates.filter((row) => {
    if (row.whatsappOptOut) { skipped += 1; return false; }
    if (!normalizeWhatsappPhone(row.phone || '')) { skipped += 1; return false; }
    return true;
  });

  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i];
    const type = stageFor(funnelForClass(funnel, classes.get(row.clientId) ?? null, configuredLead), row.daysOverdue);
    if (!type) { skipped += 1; continue; }

    const alreadySent = recentlyNotified.get(row.paymentId, type, `-${cooldownDays} days`);
    if (alreadySent) { skipped += 1; continue; }

    const to = normalizeWhatsappPhone(row.phone || '');
    const source = templateFor(type);
    const data = {
        fullName: row.clientName,
        clientCode: row.clientCode,
        phone: row.phone,
        amountCve: row.amountCve,
        dueDate: row.dueDate,
        referenceMonth: row.referenceMonth,
        invoiceNumber: row.invoiceNumber,
        daysOverdue: row.daysOverdue,
        suspensionDays: grace + 1,
        suspensionDate: cutDate(row.dueDate, grace, todayIso),
        paymentLink: row.paymentLink,
        services: row.services,
        periodLabel: row.periodLabel
      };
    const body = renderWhatsappTemplate(source, data, companyName);
    let template: WhatsappTemplate | undefined;
    if (provider.id === 'meta-cloud' && selections[type]) {
      const selected = approved.find((item) => `${item.name}|${item.language}` === selections[type]);
      if (!selected) { templateErrors.set(type, 'Modelo selecionado nao esta aprovado ou nao e suportado'); skipped += 1; continue; }
      const prepared = prepareMetaTemplate(selected, source, data, companyName);
      if (!prepared.ok) { templateErrors.set(type, prepared.reason); skipped += 1; continue; }
      template = prepared.template;
    }

    const outboxId = enqueueWhatsapp({ toPhone: to, kind: 'text', body, clientId: row.clientId, origin: 'auto', template });
    enqueued += 1;
    logNotice.run(row.paymentId, row.clientId, type, to, body, outboxId);
  }

  writeSetting(LAST_RUN_KEY, todayIso);
  return { ran: true, date: todayIso, enqueued, skipped, ...(templateErrors.size ? { templateErrors: Array.from(templateErrors, ([stage, reason]) => ({ stage, reason })) } : {}) };
}
