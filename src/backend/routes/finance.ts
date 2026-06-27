import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { computeMonthlyBilling, generateMonthlyBilling } from '../lib/billing';
import { loadAudiovisualConfig } from '../lib/audiovisual';
import { runAudiovisualAnnualIfDue } from '../lib/audiovisual-billing';
import { recordAudit } from '../lib/audit';
import {
  cancelPayment,
  executeReverseMonthly,
  markPaymentOverdue,
  payPayment,
  previewReverseMonthly,
  regeneratePayment,
  revertPayment
} from '../lib/payments';
import { createService, deleteService, serviceSchema, updateService } from '../lib/services';
import { requireAuth, requireRole } from './auth';

const monthSchema = z.object({
  referenceMonth: z.string().regex(/^\d{4}-\d{2}$/)
});

const paySchema = z.object({
  paymentMethod: z.enum(['numerario', 'transferencia', 'outro']).default('numerario'),
  paymentDate: z.string().optional()
});

const cancelSchema = z.object({
  reason: z.string().trim().optional().nullable()
});

export async function registerFinanceRoutes(app: FastifyInstance) {
  const billingWrite = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/services', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    return db.prepare(`
      SELECT
        s.id,
        s.client_id AS clientId,
        c.full_name AS clientName,
        s.plan_id AS planId,
        p.name AS planName,
        s.monthly_value_cve AS monthlyValueCve,
        s.due_day AS dueDay,
        s.status,
        s.activation_date AS activationDate,
        s.technical_notes AS technicalNotes,
        s.audiovisual_mode AS audiovisualMode,
        s.audiovisual_monthly_cve AS audiovisualMonthlyCve,
        s.audiovisual_annual_cve AS audiovisualAnnualCve
      FROM services s
      JOIN clients c ON c.id = s.client_id
      LEFT JOIN internet_plans p ON p.id = s.plan_id
      ORDER BY c.full_name
    `).all();
  });

  // Config do produto audiovisual para o formulário de serviços (qualquer
  // utilizador autenticado, ao contrário de /api/settings que é admin-only).
  app.get('/api/audiovisual-config', { preHandler: requireAuth() }, async () => {
    return loadAudiovisualConfig(getSqliteDatabase());
  });

  app.post('/api/services', billingWrite, async (request, reply) => {
    const parsed = serviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de servico invalidos' });
    }

    const result = createService(getSqliteDatabase(), parsed.data, request.user?.id ?? null);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    const created = result.value;

    recordAudit(request, {
      action: 'create',
      entityType: 'service',
      entityId: created.serviceId,
      summary: `Criou servico para cliente ${parsed.data.clientId}`,
      metadata: { clientId: parsed.data.clientId, planId: parsed.data.planId ?? null, status: parsed.data.status }
    });
    if (created.install) {
      recordAudit(request, {
        action: 'assign_device',
        entityType: 'service',
        entityId: created.serviceId,
        summary: `Instalou itens ao criar o servico ${created.serviceId}`,
        metadata: { items: created.installedItems }
      });
    }
    // Adesão à anuidade audiovisual → emite já a fatura anual (idempotente). Best
    // effort: o serviço já está criado; uma falha aqui é recuperada no arranque.
    if (parsed.data.audiovisualMode === 'annual' && parsed.data.status === 'active') {
      try {
        runAudiovisualAnnualIfDue(new Date(), created.serviceId);
      } catch {
        /* o catch-up do arranque reemite */
      }
    }
    return reply.status(201).send({
      id: created.serviceId,
      ...(created.install ?? {}),
      ...(created.costs ?? {})
    });
  });

  app.put('/api/services/:id', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = serviceSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de servico invalidos' });
    }

    const result = updateService(getSqliteDatabase(), id, parsed.data);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    // Passou a anuidade audiovisual (ou renovou) → garante a fatura do ciclo.
    if (parsed.data.audiovisualMode === 'annual' && parsed.data.status === 'active') {
      try {
        runAudiovisualAnnualIfDue(new Date(), id);
      } catch {
        /* o catch-up do arranque reemite */
      }
    }

    recordAudit(request, {
      action: 'update',
      entityType: 'service',
      entityId: id,
      summary: `Atualizou servico ${id}`,
      metadata: { clientId: parsed.data.clientId, planId: parsed.data.planId ?? null, status: parsed.data.status }
    });
    return { ok: true };
  });

  // Apagar um serviço criado por engano. Regra fiscal absoluta: um serviço que já
  // emitiu faturas (payments) NÃO pode ser apagado — a numeração sequencial e os
  // documentos fiscais têm de permanecer (usar cancelamento). Sem faturas, é seguro
  // reverter por completo a criação: devolve o stock dos equipamentos/materiais e
  // remove os filhos operacionais (child-first, foreign_keys ON).
  app.delete('/api/services/:id', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Servico invalido' });
    }

    const result = deleteService(getSqliteDatabase(), id);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    recordAudit(request, {
      action: 'delete',
      entityType: 'service',
      entityId: id,
      summary: `Apagou servico ${id} (${result.value.clientName})`,
      metadata: { clientName: result.value.clientName, restoredStock: result.value.restoredStock }
    });
    return reply.status(204).send();
  });

  app.get('/api/payments', { preHandler: requireRole(['admin', 'operator']) }, async () => {
    const db = getSqliteDatabase();
    return db.prepare(`
      SELECT
        py.id,
        py.client_id AS clientId,
        c.full_name AS clientName,
        c.client_code AS clientCode,
        c.nif AS clientNif,
        c.phone AS clientPhone,
        py.service_id AS serviceId,
        py.reference_month AS referenceMonth,
        py.amount_cve AS amountCve,
        py.due_date AS dueDate,
        py.payment_date AS paymentDate,
        py.payment_method AS paymentMethod,
        py.status,
        py.invoice_number AS invoiceNumber,
        py.invoice_date AS invoiceDate,
        py.receipt_number AS receiptNumber,
        py.receipt_date AS receiptDate,
        CASE
          WHEN py.status = 'cancelled'
            AND s.status = 'active'
            AND c.status != 'cancelled'
            AND NOT EXISTS (
              SELECT 1
              FROM payments active_py
              WHERE active_py.service_id = py.service_id
                AND active_py.reference_month = py.reference_month
                AND active_py.status != 'cancelled'
            )
          THEN 1
          ELSE 0
        END AS canRegenerate
      FROM payments py
      JOIN clients c ON c.id = py.client_id
      JOIN services s ON s.id = py.service_id
      ORDER BY py.reference_month DESC, c.full_name
    `).all();
  });

  app.post('/api/billing/preview-monthly', billingWrite, async (request, reply) => {
    const parsed = monthSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mes de referencia invalido' });
    }
    const db = getSqliteDatabase();
    return computeMonthlyBilling(db, parsed.data.referenceMonth);
  });

  app.post('/api/billing/generate-monthly', billingWrite, async (request, reply) => {
    const parsed = monthSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mes de referencia invalido' });
    }

    const db = getSqliteDatabase();
    const result = generateMonthlyBilling(db, parsed.data.referenceMonth);
    recordAudit(request, {
      action: 'generate_monthly',
      entityType: 'billing',
      entityId: parsed.data.referenceMonth,
      summary: `Gerou cobranca mensal ${parsed.data.referenceMonth}`,
      metadata: { activeServices: result.activeServices, created: result.created }
    });
    return {
      referenceMonth: result.referenceMonth,
      activeServices: result.activeServices,
      created: result.created
    };
  });

  app.post('/api/billing/preview-reverse-monthly', billingWrite, async (request, reply) => {
    const parsed = monthSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mes de referencia invalido' });
    }
    return previewReverseMonthly(getSqliteDatabase(), parsed.data.referenceMonth);
  });

  app.post('/api/billing/reverse-monthly', billingWrite, async (request, reply) => {
    const parsed = monthSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mes de referencia invalido' });
    }
    const referenceMonth = parsed.data.referenceMonth;
    const result = executeReverseMonthly(getSqliteDatabase(), referenceMonth);

    recordAudit(request, {
      action: 'reverse_monthly',
      entityType: 'billing',
      entityId: referenceMonth,
      summary: `Reverteu cobranca mensal ${referenceMonth}`,
      metadata: {
        referenceMonth,
        reversed: result.reversed,
        invoiceNumbers: result.invoiceNumbers
      }
    });

    return {
      referenceMonth,
      reversed: result.reversed
    };
  });

  app.post('/api/payments/:id/revert', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const result = revertPayment(getSqliteDatabase(), id);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    recordAudit(request, {
      action: 'revert',
      entityType: 'payment',
      entityId: id,
      summary: `Reverteu pagamento ${id}`,
      metadata: {
        referenceMonth: result.value.referenceMonth,
        invoiceNumber: result.value.invoiceNumber,
        clientId: result.value.clientId
      }
    });

    return { id, reverted: true };
  });

  app.post('/api/payments/:id/regenerate', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const result = regeneratePayment(getSqliteDatabase(), id);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    recordAudit(request, {
      action: 'regenerate',
      entityType: 'payment',
      entityId: result.value.regeneratedId,
      summary: `Regenerou mensalidade anulada ${id} como ${result.value.regeneratedId}`,
      metadata: {
        regeneratedFromId: id,
        referenceMonth: result.value.referenceMonth,
        serviceId: result.value.serviceId,
        amountCve: result.value.amountCve,
        invoiceNumber: result.value.invoiceNumber
      }
    });

    return reply.status(201).send({
      id: result.value.regeneratedId,
      regeneratedFromId: id,
      referenceMonth: result.value.referenceMonth,
      amountCve: result.value.amountCve,
      dueDate: result.value.dueDate,
      status: 'pending',
      invoiceNumber: result.value.invoiceNumber
    });
  });

  app.post('/api/payments/:id/pay', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = paySchema.safeParse(request.body || {});
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const result = payPayment(getSqliteDatabase(), id, parsed.data);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    recordAudit(request, {
      action: 'pay',
      entityType: 'payment',
      entityId: id,
      summary: `Marcou pagamento ${id} como pago`,
      metadata: { paymentMethod: parsed.data.paymentMethod }
    });
    return result.value;
  });

  app.post('/api/payments/:id/overdue', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const result = markPaymentOverdue(getSqliteDatabase(), id);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    recordAudit(request, {
      action: 'mark_overdue',
      entityType: 'payment',
      entityId: id,
      summary: `Marcou pagamento ${id} em atraso`
    });
    return result.value;
  });

  app.post('/api/payments/:id/cancel', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = cancelSchema.safeParse(request.body || {});
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    try {
      const result = cancelPayment(getSqliteDatabase(), id, parsed.data.reason);
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }
      const { payment, wasPaid, reason, priorStatus, invoiceNumber, receiptNumber, amountCve, referenceMonth } = result.value;

      recordAudit(request, {
        action: wasPaid ? 'cancel_paid' : 'cancel',
        entityType: 'payment',
        entityId: id,
        summary: wasPaid
          ? `Anulou pagamento ja registado ${id} (FT ${invoiceNumber || '-'}, REC ${receiptNumber || '-'})`
          : `Anulou pagamento ${id}`,
        metadata: {
          reason,
          priorStatus,
          invoiceNumber,
          receiptNumber,
          amountCve,
          referenceMonth
        }
      });
      return payment;
    } catch (err) {
      request.log.error({ err, paymentId: id }, 'cancel payment failed');
      return reply.status(500).send({
        error: 'Falha ao anular pagamento',
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  });
}
