import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';
import {
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  renderWhatsappTemplate
} from '../../shared/whatsapp';

const sendWhatsappSchema = z.object({
  phone: z.string().trim().min(1),
  body: z.string().trim().min(1).max(4096)
});

const notifyOverdueSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  noticeType: z.enum(['overdue', 'suspension']).optional().default('overdue')
});

const SEND_INTERVAL_MS = 900;

function normalizeUltraMsgPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (!digits) {
    return '';
  }
  if (digits.startsWith('238')) {
    return `+${digits}`;
  }
  if (digits.length === 7) {
    return `+238${digits}`;
  }
  return `+${digits}`;
}

function getSetting(key: string) {
  const db = getSqliteDatabase();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value.trim() || '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function readUltraMsgResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function sendViaUltraMsg(instanceId: string, token: string, to: string, body: string): Promise<{ ok: true; result: unknown } | { ok: false; reason: string; details?: unknown }> {
  const payload = new URLSearchParams({ token, to, body });
  try {
    const response = await fetch(`https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload
    });
    const result = await readUltraMsgResponse(response);
    if (!response.ok) {
      return { ok: false, reason: 'UltraMsg recusou o envio', details: result };
    }
    return { ok: true, result };
  } catch {
    return { ok: false, reason: 'Nao foi possivel contactar UltraMsg' };
  }
}

type OverdueCandidate = {
  paymentId: number;
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

type NotifyEntry = {
  paymentId: number;
  clientName: string;
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
};

export async function registerWhatsappRoutes(app: FastifyInstance) {
  const canSendMessages = { preHandler: requireRole(['admin', 'operator']) };

  app.post('/api/whatsapp/send', canSendMessages, async (request, reply) => {
    const parsed = sendWhatsappSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mensagem WhatsApp invalida' });
    }

    const instanceId = getSetting('ultraMsgInstanceId');
    const token = getSetting('ultraMsgToken');
    if (!instanceId || !token) {
      return reply.status(400).send({ error: 'UltraMsg nao configurado' });
    }

    const to = normalizeUltraMsgPhone(parsed.data.phone);
    if (!to) {
      return reply.status(400).send({ error: 'Telefone WhatsApp invalido' });
    }

    const result = await sendViaUltraMsg(instanceId, token, to, parsed.data.body);
    if (!result.ok) {
      return reply.status(502).send({ error: result.reason, details: result.details });
    }
    return { ok: true, provider: 'ultramsg', result: result.result };
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

    const suspensionDays = Number(getSetting('whatsappSuspensionNoticeDays')) || 15;
    const candidatesForNotice = parsed.data.noticeType === 'suspension'
      ? candidates.filter((row) => row.daysOverdue >= suspensionDays)
      : candidates;

    const eligible = candidatesForNotice.filter((row) => {
      if (row.whatsappOptOut) return false;
      const phone = normalizeUltraMsgPhone(row.phone || '');
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

    const instanceId = getSetting('ultraMsgInstanceId');
    const token = getSetting('ultraMsgToken');
    if (!instanceId || !token) {
      return reply.status(400).send({ error: 'UltraMsg nao configurado' });
    }

    const template = parsed.data.noticeType === 'suspension'
      ? getSetting('whatsappSuspensionTemplate') || fallbackWhatsappSuspensionTemplate
      : getSetting('whatsappOverdueTemplate') || getSetting('whatsappTemplate') || fallbackWhatsappOverdueTemplate || fallbackWhatsappTemplate;
    const companyName = getSetting('companyName') || 'ISPM';

    const details: NotifyEntry[] = [...skipped];
    const failed: NotifyEntry[] = [];
    let sent = 0;

    for (let i = 0; i < eligible.length; i++) {
      const row = eligible[i];
      const to = normalizeUltraMsgPhone(row.phone || '');
      const body = renderWhatsappTemplate(
        template,
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
      const result = await sendViaUltraMsg(instanceId, token, to, body);
      if (result.ok) {
        sent += 1;
        details.push({ paymentId: row.paymentId, clientName: row.clientName, status: 'sent' });
      } else {
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
