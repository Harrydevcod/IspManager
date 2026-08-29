import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { computeMonthlyBilling, generateMonthlyBilling } from '../lib/billing';
import { loadAudiovisualConfig } from '../lib/audiovisual';
import { runAudiovisualAnnualIfDue } from '../lib/audiovisual-billing';
import { recordAudit } from '../lib/audit';
import {
  applyClientCreditToPayment,
  balanceSqlExpr,
  cancelPayment,
  clientCreditBalance,
  executeReverseMonthly,
  listPaymentReceipts,
  markPaymentOverdue,
  payPayment,
  previewReverseMonthly,
  regeneratePayment,
  revertPayment,
  voidReceipt
} from '../lib/payments';
import { loadReceivables } from '../lib/receivables';
import { createService, deleteService, serviceSchema, updateService } from '../lib/services';
import { serviceTransferSchema, transferService } from '../lib/serviceTransfer';
import { requireAuth, requireRole } from './auth';

const monthSchema = z.object({
  referenceMonth: z.string().regex(/^\d{4}-\d{2}$/)
});

const paySchema = z.object({
  paymentMethod: z.enum(['numerario', 'transferencia', 'outro']).default('numerario'),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Ausente = recebe o saldo todo, como sempre foi. Presente = parcial (ou, se
  // exceder, parcial + credito).
  amountCve: z.number().finite().positive().optional()
});

const voidReceiptSchema = z.object({
  reason: z.string().trim().optional().nullable()
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
        s.audiovisual_annual_cve AS audiovisualAnnualCve,
        s.pppoe_username AS pppoeUsername,
        s.pppoe_password AS pppoePassword,
        -- Realidade lida do router (ADR 0007): a lista mostra quem está mesmo
        -- online, sem ir buscá-lo serviço a serviço.
        n.online AS routerOnline,
        n.router_enabled AS routerEnabled,
        n.divergence AS routerDivergence,
        -- IPs dos equipamentos ativos: chave de identificacao das antenas para
        -- manutencao remota, por isso vem ja na lista e nao so no detalhe.
        -- Pela vista assignment_services, para uma antena partilhada aparecer em
        -- todos os clientes que serve e não só no titular.
        (
          SELECT group_concat(a.ip_address, ', ')
          FROM assignment_services asv
          JOIN service_device_assignments a ON a.id = asv.assignment_id
          WHERE asv.service_id = s.id AND a.end_date IS NULL AND a.ip_address IS NOT NULL
        ) AS deviceIps
      FROM services s
      JOIN clients c ON c.id = s.client_id
      LEFT JOIN internet_plans p ON p.id = s.plan_id
      LEFT JOIN service_network_state n ON n.service_id = s.id
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
    if (created.installationFee) {
      recordAudit(request, {
        action: 'create',
        entityType: 'payment',
        entityId: created.installationFee.paymentId,
        summary: `Emitiu fatura de instalacao do servico ${created.serviceId}`,
        metadata: { serviceId: created.serviceId, paymentId: created.installationFee.paymentId }
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
      ...(created.costs ?? {}),
      ...(created.installationFee ?? {})
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

  // Transferir o titular: a casa muda de inquilino, ou o equipamento é recolhido
  // e reinstalado noutro cliente. O histórico de faturação fica com quem foi
  // faturado; o serviço vivo segue para o novo titular, com registo na cronologia.
  app.post('/api/services/:id/transfer', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = serviceTransferSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de transferencia invalidos' });
    }

    const result = transferService(getSqliteDatabase(), id, parsed.data, request.user?.id ?? null);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    const transfer = result.value;

    recordAudit(request, {
      action: 'transfer',
      entityType: 'service',
      entityId: id,
      summary: `Transferiu servico ${id} de ${transfer.fromClient.name} para ${transfer.toClient.name}`,
      metadata: {
        fromClientId: transfer.fromClient.id,
        toClientId: transfer.toClient.id,
        mode: transfer.mode,
        clientReactivated: transfer.clientReactivated,
        previousStatus: transfer.previousStatus,
        status: transfer.status,
        freedIps: transfer.freedIps,
        pppoeRegenerated: transfer.pppoeRegenerated
      }
    });
    return transfer;
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
        COALESCE((
          SELECT SUM(r.amount_cve) FROM payment_receipts r
          WHERE r.payment_id = py.id AND r.voided_at IS NULL
        ), 0) AS receivedCve,
        ${balanceSqlExpr('py')} AS balanceCve,
        CASE
          WHEN py.status = 'cancelled'
            -- Espelha regenerateMonthlyPayment: só o serviço cancelado bloqueia.
            -- O suspenso regenera a fatura de aluguer que lhe foi anulada.
            AND s.status != 'cancelled'
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
        // Documentos numerados que a reversão deixou intactos. Antes eram
        // apagados e o registo guardava os números destruídos.
        invoicedKept: result.invoicedKept
      }
    });

    return {
      referenceMonth,
      reversed: result.reversed,
      invoicedKept: result.invoicedKept
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

    const userId = (request as { user?: { id?: number } }).user?.id ?? null;
    const result = payPayment(getSqliteDatabase(), id, { ...parsed.data, userId });
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    const { receipt, settled, balanceCve, creditAddedCve } = result.value;
    recordAudit(request, {
      action: 'pay',
      entityType: 'payment',
      entityId: id,
      summary: settled
        ? `Recebeu ${receipt.amountCve} e liquidou o pagamento ${id} (recibo ${receipt.receiptNumber})`
        : `Recebeu ${receipt.amountCve} por conta do pagamento ${id} (recibo ${receipt.receiptNumber}), saldo ${balanceCve}`,
      metadata: {
        paymentMethod: parsed.data.paymentMethod,
        receiptId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        amountCve: receipt.amountCve,
        balanceCve,
        creditAddedCve,
        settled
      }
    });
    return result.value;
  });

  app.get('/api/payments/:id/receipts', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }
    const db = getSqliteDatabase();
    const row = db.prepare('SELECT client_id AS clientId FROM payments WHERE id = ?').get(id) as { clientId: number } | undefined;
    if (!row) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    return {
      receipts: listPaymentReceipts(db, id),
      clientCreditCve: clientCreditBalance(db, row.clientId)
    };
  });

  app.post('/api/payments/:id/apply-credit', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const db = getSqliteDatabase();
    const userId = (request as { user?: { id?: number } }).user?.id ?? null;
    const receipt = applyClientCreditToPayment(db, id, userId);
    if (!receipt) {
      return reply.status(400).send({ error: 'Sem credito disponivel ou fatura sem saldo em aberto' });
    }

    recordAudit(request, {
      action: 'apply_credit',
      entityType: 'payment',
      entityId: id,
      summary: `Abateu ${receipt.amountCve} de conta corrente no pagamento ${id} (recibo ${receipt.receiptNumber})`,
      metadata: { receiptId: receipt.id, receiptNumber: receipt.receiptNumber, amountCve: receipt.amountCve }
    });
    return receipt;
  });

  app.post('/api/receipts/:id/void', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = voidReceiptSchema.safeParse(request.body || {});
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Recibo invalido' });
    }

    const result = voidReceipt(getSqliteDatabase(), id, parsed.data.reason);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    recordAudit(request, {
      action: 'void_receipt',
      entityType: 'receipt',
      entityId: id,
      summary: `Anulou o recibo ${result.value.receipt.receiptNumber} do pagamento ${result.value.paymentId}`,
      metadata: {
        paymentId: result.value.paymentId,
        reason: parsed.data.reason,
        reopened: result.value.reopened,
        balanceCve: result.value.balanceCve
      }
    });
    return result.value;
  });

  app.get('/api/receivables', { preHandler: requireRole(['admin', 'operator']) }, async () => {
    return loadReceivables(getSqliteDatabase());
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
