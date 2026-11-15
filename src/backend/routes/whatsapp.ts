import { isSystemClient, SYSTEM_CLIENT_ERROR } from '../lib/system-client';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';
import {
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappInvoiceReadyTemplate,
  fallbackWhatsappReceiptTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  renderWhatsappTemplate
} from '../../shared/whatsapp';
import { balanceSqlExpr, overdueSqlPredicate } from '../lib/payments';
import { openPaymentLinkSql } from '../lib/vinti4';
import { enqueueWhatsapp, runWhatsappOutboxIfDue, WHATSAPP_CHANNEL_OFF_ERROR } from '../lib/whatsapp-outbox';
import { configuredWhatsappProviderLabel, normalizeWhatsappPhone, resolveWhatsappProvider, whatsappChannelEnabled } from '../lib/whatsapp-provider';
import { autoSuspensionGraceDays } from '../lib/auto-suspension';
import { loadFunnel } from '../lib/notices';
import { cutDate } from '../../shared/business-day';
import { listMetaCloudTemplates } from '../lib/meta-cloud';
import { readSecret } from '../lib/secrets';
import { prepareMetaTemplate } from '../lib/meta-template';
import type { WhatsappTemplate } from '../lib/whatsapp-provider';

const sendWhatsappSchema = z.object({
  phone: z.string().trim().min(1),
  body: z.string().trim().min(1).max(4096),
  paymentId: z.number().int().positive().optional(),
  event: z.enum(['invoice', 'receipt', 'overdue', 'suspension']).optional()
}).refine((value) => Boolean(value.paymentId) === Boolean(value.event));

const notifyOverdueSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  noticeType: z.enum(['overdue', 'suspension']).optional().default('overdue')
});

const SEND_INTERVAL_MS = 900;

function getSetting(key: string) {
  const db = getSqliteDatabase();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value.trim() || '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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
  paymentLink: string | null;
  daysOverdue: number;
  whatsappOptOut: number;
};

type NotifyEntry = {
  paymentId: number;
  clientName: string;
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
};

type ManualOutboxStatus = { status: string; last_error: string | null };

function replyWithManualOutboxResult(
  reply: FastifyReply,
  row: ManualOutboxStatus,
  fallback: string
) {
  if (row.status === 'sent' || row.status === 'delivered' || row.status === 'read') {
    return null;
  }
  return reply.status(502).send({
    error: row.last_error || fallback,
    status: row.status
  });
}

export async function registerWhatsappRoutes(app: FastifyInstance) {
  const canSendMessages = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/whatsapp/meta/templates', { preHandler: requireRole(['admin']) }, async (_request, reply) => {
    const account = getSetting('metaBusinessAccountId');
    const token = readSecret(getSqliteDatabase(), 'metaAccessToken');
    if (!/^\d{1,32}$/.test(account) || !token) return reply.status(409).send({ error: 'Configure a conta WhatsApp Business e o token da Meta' });
    const result = await listMetaCloudTemplates(account, token);
    if (!result.ok) return reply.status(502).send({ error: result.reason });
    return { templates: result.templates };
  });

  app.post('/api/whatsapp/send', canSendMessages, async (request, reply) => {
    const parsed = sendWhatsappSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mensagem WhatsApp invalida' });
    }

    if (!whatsappChannelEnabled(getSqliteDatabase())) {
      return reply.status(409).send({ error: WHATSAPP_CHANNEL_OFF_ERROR });
    }
    const provider = resolveWhatsappProvider(getSqliteDatabase());
    if (!provider) {
      return reply.status(400).send({ error: `${configuredWhatsappProviderLabel(getSqliteDatabase())} nao configurado` });
    }

    const to = normalizeWhatsappPhone(parsed.data.phone);
    if (!to) {
      return reply.status(400).send({ error: 'Telefone WhatsApp invalido' });
    }

    let metaTemplate: WhatsappTemplate | undefined;
    if (provider.id === 'meta-cloud' && parsed.data.paymentId && parsed.data.event) {
      const eventKeys = { invoice: ['metaTemplateInvoice', 'whatsappInvoiceReadyTemplate', fallbackWhatsappInvoiceReadyTemplate], receipt: ['metaTemplateReceipt', 'whatsappReceiptTemplate', fallbackWhatsappReceiptTemplate], overdue: ['metaTemplateOverdue', 'whatsappOverdueTemplate', fallbackWhatsappOverdueTemplate], suspension: ['metaTemplateSuspension', 'whatsappSuspensionTemplate', fallbackWhatsappSuspensionTemplate] } as const;
      const [selectionKey, sourceKey, fallback] = eventKeys[parsed.data.event];
      const selection = getSetting(selectionKey);
      if (selection) {
        const db = getSqliteDatabase();
        const payment = db.prepare(`SELECT c.id AS clientId, c.full_name AS fullName, c.client_code AS clientCode, c.phone, py.amount_cve AS amountCve, py.due_date AS dueDate, py.reference_month AS referenceMonth, py.invoice_number AS invoiceNumber, py.receipt_number AS receiptNumber, ${openPaymentLinkSql('py')} AS paymentLink FROM payments py JOIN clients c ON c.id = py.client_id WHERE py.id = ?`).get(parsed.data.paymentId) as { clientId: number; fullName: string; clientCode: string; phone: string | null; amountCve: number; dueDate: string; referenceMonth: string; invoiceNumber: string | null; receiptNumber: string | null; paymentLink: string | null } | undefined;
        if (!payment || isSystemClient(db, payment.clientId) || normalizeWhatsappPhone(payment.phone || '') !== to) return reply.status(409).send({ error: 'Pagamento ou telefone nao corresponde ao cliente' });
        const grace = autoSuspensionGraceDays(db);
        const data = { ...payment, daysOverdue: Math.max(0, Math.floor((Date.now() - new Date(`${payment.dueDate}T00:00:00`).getTime()) / 86_400_000)), suspensionDays: grace + 1, suspensionDate: cutDate(payment.dueDate, grace) };
        const source = getSetting(sourceKey) || fallback;
        const company = getSetting('companyName') || 'ISPM';
        if (renderWhatsappTemplate(source, data, company).trim() !== parsed.data.body) return reply.status(409).send({ error: 'A mensagem mudou; atualize a fatura antes de enviar' });
        const account = getSetting('metaBusinessAccountId');
        const token = readSecret(db, 'metaAccessToken');
        if (!/^\d{1,32}$/.test(account) || !token) return reply.status(409).send({ error: 'Conta WhatsApp Business nao configurada' });
        const models = await listMetaCloudTemplates(account, token);
        if (!models.ok) return reply.status(502).send({ error: models.reason });
        const selected = models.templates.find((model) => `${model.name}|${model.language}` === selection);
        if (!selected) return reply.status(409).send({ error: 'Modelo selecionado nao esta aprovado ou nao e suportado' });
        const prepared = prepareMetaTemplate(selected, source, data, company);
        if (!prepared.ok) return reply.status(409).send({ error: prepared.reason });
        metaTemplate = prepared.template;
      }
    }
    const id = enqueueWhatsapp({ toPhone: to, kind: 'text', body: parsed.data.body, origin: 'manual', template: metaTemplate });
    await runWhatsappOutboxIfDue(new Date(), undefined, { onlyId: id });
    const row = getSqliteDatabase().prepare('SELECT status, last_error FROM whatsapp_outbox WHERE id = ?').get(id) as ManualOutboxStatus;
    const failed = replyWithManualOutboxResult(reply, row, 'Falha no envio');
    if (failed) return failed;
    return { ok: true, provider: provider.id, id, status: row.status };
  });

  const sendDocumentSchema = z.object({ kind: z.enum(['invoice', 'receipt']) });

  app.post('/api/payments/:id/whatsapp', canSendMessages, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = sendDocumentSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Pedido invalido' });
    }
    if (!whatsappChannelEnabled(getSqliteDatabase())) {
      return reply.status(409).send({ error: WHATSAPP_CHANNEL_OFF_ERROR });
    }
    const provider = resolveWhatsappProvider(getSqliteDatabase());
    if (!provider) {
      return reply.status(400).send({ error: `${configuredWhatsappProviderLabel(getSqliteDatabase())} nao configurado` });
    }
    const payment = getSqliteDatabase().prepare(`
      SELECT py.id AS id, c.id AS clientId, c.phone AS phone
      FROM payments py JOIN clients c ON c.id = py.client_id
      WHERE py.id = ?
    `).get(id) as { id: number; clientId: number; phone: string | null } | undefined;
    if (!payment) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    if (isSystemClient(getSqliteDatabase(), payment.clientId)) {
      return reply.status(409).send({ error: SYSTEM_CLIENT_ERROR });
    }
    const to = normalizeWhatsappPhone(payment.phone || '');
    if (!to) {
      return reply.status(400).send({ error: 'Cliente sem telefone WhatsApp valido' });
    }
    const caption = parsed.data.kind === 'invoice' ? 'A sua fatura.' : 'O seu recibo.';
    const outboxId = enqueueWhatsapp({
      toPhone: to, kind: 'document', body: caption,
      docPaymentId: payment.id, docKind: parsed.data.kind, clientId: payment.clientId, origin: 'manual'
    });
    await runWhatsappOutboxIfDue(new Date(), undefined, { onlyId: outboxId });
    const row = getSqliteDatabase().prepare('SELECT status, last_error FROM whatsapp_outbox WHERE id = ?').get(outboxId) as ManualOutboxStatus;
    const failed = replyWithManualOutboxResult(reply, row, 'Falha no envio do documento');
    if (failed) return failed;
    return { ok: true, id: outboxId, status: row.status };
  });

  app.post('/api/payments/notify-overdue', canSendMessages, async (request, reply) => {
    const parsed = notifyOverdueSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }

    const db = getSqliteDatabase();
    const candidates = db.prepare(`
      SELECT
        py.id AS paymentId,
        c.id AS clientId,
        c.full_name AS clientName,
        c.client_code AS clientCode,
        c.phone AS phone,
        c.whatsapp_opt_out AS whatsappOptOut,
        -- O aviso tem de dizer o que FALTA. Mandar o valor cheio a quem ja
        -- entregou metade e a maneira mais rapida de perder a confianca do
        -- cliente na cobranca.
        ${balanceSqlExpr('py')} AS amountCve,
        py.due_date AS dueDate,
        py.reference_month AS referenceMonth,
        py.invoice_number AS invoiceNumber,
        ${openPaymentLinkSql('py')} AS paymentLink,
        CAST(julianday('now') - julianday(py.due_date) AS INTEGER) AS daysOverdue
      FROM payments py
      JOIN clients c ON c.id = py.client_id
      WHERE c.system_kind IS NULL AND py.document_type = 'invoice' AND ${overdueSqlPredicate('py')}
      ORDER BY py.due_date ASC
    `).all() as OverdueCandidate[];

    const grace = autoSuspensionGraceDays(db);
    const suspensionStart = loadFunnel().find((stage) => stage.stage === 'suspension')?.threshold ?? grace + 1;
    const candidatesForNotice = parsed.data.noticeType === 'suspension'
      ? candidates.filter((row) => row.daysOverdue >= suspensionStart)
      : candidates;

    const eligible = candidatesForNotice.filter((row) => {
      if (row.whatsappOptOut) return false;
      const phone = normalizeWhatsappPhone(row.phone || '');
      return phone.length > 0;
    });

    const skipped: NotifyEntry[] = candidatesForNotice
      .filter((row) => !eligible.some((e) => e.paymentId === row.paymentId))
      .map((row) => ({
        paymentId: row.paymentId,
        clientName: row.clientName,
        status: 'skipped' as const,
        reason: row.whatsappOptOut ? 'opt-out' : 'sem telefone valido'
      }));

    if (parsed.data.dryRun) {
      return {
        dryRun: true,
        total: candidatesForNotice.length,
        eligible: eligible.map((row) => ({
          paymentId: row.paymentId,
          clientName: row.clientName,
          clientCode: row.clientCode,
          phone: row.phone,
          amountCve: row.amountCve,
          dueDate: row.dueDate,
          daysOverdue: row.daysOverdue
        })),
        skipped
      };
    }

    if (eligible.length === 0) {
      return { dryRun: false, total: candidatesForNotice.length, sent: 0, failed: [], skipped, details: [] };
    }

    if (!whatsappChannelEnabled(getSqliteDatabase())) {
      return reply.status(409).send({ error: WHATSAPP_CHANNEL_OFF_ERROR });
    }
    const provider = resolveWhatsappProvider(getSqliteDatabase());
    if (!provider) {
      return reply.status(400).send({ error: `${configuredWhatsappProviderLabel(getSqliteDatabase())} nao configurado` });
    }

    const template = parsed.data.noticeType === 'suspension'
      ? getSetting('whatsappSuspensionTemplate') || fallbackWhatsappSuspensionTemplate
      : getSetting('whatsappOverdueTemplate') || getSetting('whatsappTemplate') || fallbackWhatsappOverdueTemplate || fallbackWhatsappTemplate;
    const companyName = getSetting('companyName') || 'ISPM';
    const metaSelection = provider.id === 'meta-cloud' ? getSetting(parsed.data.noticeType === 'suspension' ? 'metaTemplateSuspension' : 'metaTemplateOverdue') : '';
    let selectedModel: { name: string; language: string; body: string } | undefined;
    if (metaSelection) {
      const account = getSetting('metaBusinessAccountId');
      const token = readSecret(db, 'metaAccessToken');
      if (!/^\d{1,32}$/.test(account) || !token) return reply.status(409).send({ error: 'Conta WhatsApp Business nao configurada' });
      const models = await listMetaCloudTemplates(account, token);
      if (!models.ok) return reply.status(502).send({ error: models.reason });
      selectedModel = models.templates.find((model) => `${model.name}|${model.language}` === metaSelection);
      if (!selectedModel) return reply.status(409).send({ error: 'Modelo selecionado nao esta aprovado ou nao e suportado' });
    }

    const logNotice = db.prepare(`
      INSERT INTO whatsapp_notices (payment_id, client_id, notice_type, origin, phone, body, status, error)
      VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)
    `);

    const details: NotifyEntry[] = [...skipped];
    const failed: NotifyEntry[] = [];
    let sent = 0;

    for (let i = 0; i < eligible.length; i++) {
      const row = eligible[i];
      const to = normalizeWhatsappPhone(row.phone || '');
      const messageData = {
          fullName: row.clientName,
          clientCode: row.clientCode,
          phone: row.phone,
          amountCve: row.amountCve,
          dueDate: row.dueDate,
          referenceMonth: row.referenceMonth,
          invoiceNumber: row.invoiceNumber,
          daysOverdue: row.daysOverdue,
          suspensionDays: grace + 1,
          suspensionDate: cutDate(row.dueDate, grace),
          paymentLink: row.paymentLink
        };
      const body = renderWhatsappTemplate(template, messageData, companyName);
      let metaTemplate: WhatsappTemplate | undefined;
      if (selectedModel) {
        const prepared = prepareMetaTemplate(selectedModel, template, messageData, companyName);
        if (!prepared.ok) {
          logNotice.run(row.paymentId, row.clientId, parsed.data.noticeType, to, body, 'failed', prepared.reason);
          const entry: NotifyEntry = { paymentId: row.paymentId, clientName: row.clientName, status: 'failed', reason: prepared.reason };
          failed.push(entry); details.push(entry); continue;
        }
        metaTemplate = prepared.template;
      }
      const result = await provider.sendText({ to, body, ...(metaTemplate ? { template: metaTemplate } : {}) });
      if (result.ok) {
        sent += 1;
        logNotice.run(row.paymentId, row.clientId, parsed.data.noticeType, to, body, 'sent', null);
        details.push({ paymentId: row.paymentId, clientName: row.clientName, status: 'sent' });
      } else {
        logNotice.run(row.paymentId, row.clientId, parsed.data.noticeType, to, body, 'failed', result.reason);
        const entry: NotifyEntry = { paymentId: row.paymentId, clientName: row.clientName, status: 'failed', reason: result.reason };
        failed.push(entry);
        details.push(entry);
      }
      if (i < eligible.length - 1) {
        await delay(SEND_INTERVAL_MS);
      }
    }

    return {
      dryRun: false,
      total: candidatesForNotice.length,
      sent,
      failed,
      skipped,
      details
    };
  });
}
