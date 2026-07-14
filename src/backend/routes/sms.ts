import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';
import { discoverCompanionHosts, enqueueSmsNotification, findPairedCompanion, verifyCompanionPairing } from '../lib/sms-outbox';
import { SMS_REPORT_TIMEZONE, smsReportMonthUtcRange } from '../../shared/sms-report';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate,
  normalizeSmsPhone,
  renderSmsTemplate,
  type SmsEventType
} from '../../shared/sms';

const pairingSchema = z.object({
  baseUrl: z.string().url(),
  deviceName: z.string().trim().min(1).max(80)
});

const paymentSmsSchema = z.object({
  eventType: z.enum(['invoice_issued', 'receipt_confirmed', 'payment_overdue', 'suspension_notice'])
});

const reportQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
});

type SmsReportCounts = {
  pendingDispatch: number | null;
  pendingApproval: number | null;
  sent: number | null;
  failed: number | null;
  rejected: number | null;
};

function getSetting(key: string): string {
  const row = getSqliteDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || '';
}

function setSetting(key: string, value: string) {
  getSqliteDatabase().prepare(`
    INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, value);
}

function templateFor(eventType: SmsEventType): string {
  const keys: Record<SmsEventType, [string, string]> = {
    invoice_issued: ['smsInvoiceIssuedTemplate', fallbackSmsInvoiceIssuedTemplate],
    receipt_confirmed: ['smsReceiptConfirmedTemplate', fallbackSmsReceiptConfirmedTemplate],
    payment_overdue: ['smsPaymentOverdueTemplate', fallbackSmsPaymentOverdueTemplate],
    suspension_notice: ['smsSuspensionNoticeTemplate', fallbackSmsSuspensionNoticeTemplate]
  };
  const [key, fallback] = keys[eventType];
  return getSetting(key) || fallback;
}

export async function registerSmsRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };
  const canSend = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/sms/status', adminOnly, async () => {
    const enabled = getSetting('smsCompanionEnabled') === 'true';
    const baseUrl = getSetting('smsCompanionBaseUrl');
    const deviceName = getSetting('smsCompanionDeviceName');
    const pairingKey = getSetting('smsCompanionPairingKey');
    const configured = Boolean(baseUrl && pairingKey);
    const verification = configured
      ? await verifyCompanionPairing(1200)
      : { reachable: false, paired: false };
    return {
      configured,
      reachable: verification.reachable,
      paired: verification.paired,
      active: enabled && verification.reachable && verification.paired,
      baseUrl,
      deviceName
    };
  });

  app.get('/api/sms/report', adminOnly, async (request, reply) => {
    const parsed = reportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mes do relatorio SMS invalido' });
    }

    const range = smsReportMonthUtcRange(parsed.data.month);
    if (!range) {
      return reply.status(400).send({ error: 'Mes do relatorio SMS invalido' });
    }

    const counts = getSqliteDatabase().prepare(`
      SELECT
        SUM(CASE WHEN status='pending_dispatch' THEN 1 ELSE 0 END) AS pendingDispatch,
        SUM(CASE WHEN status='pending_approval' THEN 1 ELSE 0 END) AS pendingApproval,
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM sms_outbox
      WHERE created_at >= ? AND created_at < ?
    `).get(range.startUtc, range.endUtc) as SmsReportCounts;

    return {
      month: parsed.data.month,
      timezone: SMS_REPORT_TIMEZONE,
      counts: {
        pendingDispatch: counts.pendingDispatch ?? 0,
        pendingApproval: counts.pendingApproval ?? 0,
        sent: counts.sent ?? 0,
        failed: counts.failed ?? 0,
        rejected: counts.rejected ?? 0
      }
    };
  });

  app.get('/api/sms/pairing/verify', adminOnly, async () => {
    const result = await verifyCompanionPairing();
    return { ...result, deviceName: getSetting('smsCompanionDeviceName') };
  });

  // Locates the phone on the LAN so the operator doesn't have to hunt for its IP.
  // If already paired, pinpoints the exact device by pairing secret; otherwise
  // returns whichever host(s) answer on the companion port.
  app.post('/api/sms/discover', adminOnly, async () => {
    const hosts = await discoverCompanionHosts();
    let baseUrl: string | null = getSetting('smsCompanionPairingKey')
      ? await findPairedCompanion(hosts)
      : null;
    if (!baseUrl && hosts.length === 1) baseUrl = hosts[0];
    return { candidates: hosts, baseUrl };
  });

  app.post('/api/sms/pairing', adminOnly, async (request, reply) => {
    const parsed = pairingSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Pareamento SMS invalido' });
    const secret = randomBytes(32).toString('hex');
    setSetting('smsCompanionEnabled', 'true');
    setSetting('smsCompanionBaseUrl', parsed.data.baseUrl);
    setSetting('smsCompanionDeviceName', parsed.data.deviceName);
    setSetting('smsCompanionPairingKey', secret);
    setSetting('smsCompanionPairingKeyHash', createHash('sha256').update(secret).digest('hex'));
    const qrPayload = `ispm-sms://pair?secret=${encodeURIComponent(secret)}&device=${encodeURIComponent(parsed.data.deviceName)}`;
    return { ok: true, secret, qrPayload };
  });

  app.delete('/api/sms/pairing', adminOnly, async () => {
    setSetting('smsCompanionEnabled', 'false');
    setSetting('smsCompanionPairingKey', '');
    setSetting('smsCompanionPairingKeyHash', '');
    return { ok: true };
  });

  app.post('/api/payments/:id/sms', canSend, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = paymentSmsSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) return reply.status(400).send({ error: 'Pedido SMS invalido' });

    const payment = getSqliteDatabase().prepare(`
      SELECT py.id, py.service_id AS serviceId, py.client_id AS clientId, py.reference_month AS referenceMonth,
             py.amount_cve AS amountCve, py.due_date AS dueDate, py.invoice_number AS invoiceNumber,
             py.receipt_number AS receiptNumber, py.status, c.full_name AS fullName,
             c.client_code AS clientCode, c.phone
      FROM payments py JOIN clients c ON c.id = py.client_id
      WHERE py.id = ?
    `).get(id) as {
      id: number; serviceId: number; clientId: number; referenceMonth: string; amountCve: number;
      dueDate: string; invoiceNumber: string | null; receiptNumber: string | null; status: string;
      fullName: string; clientCode: string | null; phone: string | null;
    } | undefined;
    if (!payment) return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    const toPhone = normalizeSmsPhone(payment.phone || '');
    if (!toPhone) return reply.status(400).send({ error: 'Cliente sem telefone SMS valido' });
    if (parsed.data.eventType === 'receipt_confirmed' && payment.status !== 'paid') {
      return reply.status(400).send({ error: 'Recibo SMS exige pagamento pago' });
    }

    const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(`${payment.dueDate}T00:00:00`).getTime()) / 86_400_000));
    const body = renderSmsTemplate(templateFor(parsed.data.eventType), {
      fullName: payment.fullName,
      clientCode: payment.clientCode,
      phone: toPhone,
      amountCve: payment.amountCve,
      dueDate: payment.dueDate,
      referenceMonth: payment.referenceMonth,
      invoiceNumber: payment.invoiceNumber,
      receiptNumber: payment.receiptNumber,
      daysOverdue,
      suspensionDays: Number(getSetting('whatsappSuspensionNoticeDays')) || 15
    }, getSetting('companyName') || 'ISPM');
    const outboxId = enqueueSmsNotification({
      clientId: payment.clientId,
      paymentId: payment.id,
      serviceId: payment.serviceId,
      eventType: parsed.data.eventType,
      toPhone,
      body
    });
    return { ok: true, id: outboxId, status: 'pending_dispatch' };
  });
}
