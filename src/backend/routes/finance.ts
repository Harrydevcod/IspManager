import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { buildMonthlyServiceLines, computeMonthlyBilling, dueDateFromIssue, generateMonthlyBilling, sumLines, todayIso, type BillingLine } from '../lib/billing';
import { nextDocumentNumber } from '../lib/numbering';
import { isAudiovisualAnnualReference, loadAudiovisualConfig } from '../lib/audiovisual';
import { runAudiovisualAnnualIfDue } from '../lib/audiovisual-billing';
import { recordAudit } from '../lib/audit';
import {
  insertInstallCostsWithinTx,
  installItemsWithinTx,
  mapInstallError,
  preflightItems,
  type InstallCostInput,
  type ServiceItemInput
} from '../lib/serviceInstall';
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

const serviceItemSchema = z.object({
  catalogId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().optional().nullable(),
  serialNumber: z.string().trim().optional().nullable(),
  assetTag: z.string().trim().optional().nullable(),
  ipAddress: z.string().trim().optional().nullable(),
  macAddress: z.string().trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});

const installCostSchema = z.object({
  kind: z.enum(['mao_de_obra', 'transporte', 'outro']).default('mao_de_obra'),
  description: z.string().trim().optional().nullable(),
  amountCve: z.coerce.number().min(0)
});

const serviceSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  planId: z.coerce.number().int().positive().optional().nullable(),
  monthlyValueCve: z.coerce.number().min(0),
  dueDay: z.coerce.number().int().min(1).max(31).default(1),
  activationDate: z.string().optional().nullable(),
  status: z.enum(['active', 'suspended', 'cancelled']).default('active'),
  technicalNotes: z.string().trim().optional().nullable(),
  audiovisualMode: z.enum(['none', 'monthly', 'annual']).optional().default('none'),
  audiovisualMonthlyCve: z.coerce.number().min(0).optional().default(0),
  audiovisualAnnualCve: z.coerce.number().min(0).optional().default(0),
  items: z.array(serviceItemSchema).optional().nullable(),
  installCosts: z.array(installCostSchema).optional().nullable()
});

/**
 * Regras do add-on audiovisual: a modalidade ativa exige o respetivo preço > 0; e
 * um serviço não pode ficar vazio (sem mensalidade de internet nem audiovisual),
 * caso contrário não geraria qualquer fatura. Devolve a mensagem de erro ou null.
 */
function validateServicePayload(data: {
  monthlyValueCve: number;
  audiovisualMode: 'none' | 'monthly' | 'annual';
  audiovisualMonthlyCve: number;
  audiovisualAnnualCve: number;
}): string | null {
  if (data.audiovisualMode === 'monthly' && data.audiovisualMonthlyCve <= 0) {
    return 'Valor mensal de conteúdos audiovisuais deve ser superior a zero';
  }
  if (data.audiovisualMode === 'annual' && data.audiovisualAnnualCve <= 0) {
    return 'Valor anual de conteúdos audiovisuais deve ser superior a zero';
  }
  const hasMonthlyCharge = data.monthlyValueCve > 0 || (data.audiovisualMode === 'monthly' && data.audiovisualMonthlyCve > 0);
  const hasAnnualCharge = data.audiovisualMode === 'annual' && data.audiovisualAnnualCve > 0;
  if (!hasMonthlyCharge && !hasAnnualCharge) {
    return 'Serviço sem valor: defina a mensalidade ou ative os conteúdos audiovisuais';
  }
  return null;
}

const nextNumber = nextDocumentNumber;

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
        s.monthly_value_centavos / 100.0 AS monthlyValueCve,
        s.due_day AS dueDay,
        s.status,
        s.activation_date AS activationDate,
        s.technical_notes AS technicalNotes,
        s.audiovisual_mode AS audiovisualMode,
        s.audiovisual_monthly_centavos / 100.0 AS audiovisualMonthlyCve,
        s.audiovisual_annual_centavos / 100.0 AS audiovisualAnnualCve
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

    const validationError = validateServicePayload(parsed.data);
    if (validationError) {
      return reply.status(400).send({ error: validationError });
    }

    const db = getSqliteDatabase();
    const client = db.prepare('SELECT id, full_name AS fullName FROM clients WHERE id = ?')
      .get(parsed.data.clientId) as { id: number; fullName: string } | undefined;
    if (!client) {
      return reply.status(404).send({ error: 'Cliente nao encontrado' });
    }

    if (parsed.data.planId) {
      const plan = db.prepare('SELECT id FROM internet_plans WHERE id = ?').get(parsed.data.planId);
      if (!plan) {
        return reply.status(404).send({ error: 'Plano nao encontrado' });
      }
    }

    const items = (parsed.data.items ?? []) as ServiceItemInput[];
    if (items.length > 0) {
      const preflight = preflightItems(db, items);
      if (!preflight.ok) {
        return reply.status(preflight.status).send({ error: preflight.error });
      }
    }
    const installCosts = (parsed.data.installCosts ?? []) as InstallCostInput[];

    const run = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT INTO services (
          client_id, plan_id, monthly_value_centavos, activation_date, due_day,
          status, technical_notes, audiovisual_mode, audiovisual_monthly_centavos,
          audiovisual_annual_centavos, created_at, updated_at
        )
        VALUES (?, ?, CAST(ROUND(? * 100) AS INTEGER), ?, ?, ?, ?, ?, CAST(ROUND(? * 100) AS INTEGER), CAST(ROUND(? * 100) AS INTEGER), datetime('now'), datetime('now'))
      `).run(
        parsed.data.clientId,
        parsed.data.planId || null,
        parsed.data.monthlyValueCve,
        parsed.data.activationDate || null,
        parsed.data.dueDay,
        parsed.data.status,
        parsed.data.technicalNotes || null,
        parsed.data.audiovisualMode,
        parsed.data.audiovisualMonthlyCve,
        parsed.data.audiovisualAnnualCve
      );
      const serviceId = Number(inserted.lastInsertRowid);

      const install = items.length > 0
        ? installItemsWithinTx(db, {
            serviceId,
            clientName: client.fullName,
            items,
            userId: request.user?.id ?? null
          })
        : null;

      const costs = installCosts.length > 0
        ? insertInstallCostsWithinTx(db, { serviceId, costs: installCosts, userId: request.user?.id ?? null })
        : null;

      return { serviceId, install, costs };
    });

    let created: {
      serviceId: number;
      install: ReturnType<typeof installItemsWithinTx> | null;
      costs: ReturnType<typeof insertInstallCostsWithinTx> | null;
    };
    try {
      created = run();
    } catch (error) {
      const mapped = mapInstallError(error);
      if (mapped) {
        return reply.status(mapped.status).send({ error: mapped.error });
      }
      throw error;
    }

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
        metadata: { items: items.length }
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

    const validationError = validateServicePayload(parsed.data);
    if (validationError) {
      return reply.status(400).send({ error: validationError });
    }

    const db = getSqliteDatabase();
    const service = db.prepare('SELECT id FROM services WHERE id = ?').get(id);
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }

    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(parsed.data.clientId);
    if (!client) {
      return reply.status(404).send({ error: 'Cliente nao encontrado' });
    }

    if (parsed.data.planId) {
      const plan = db.prepare('SELECT id FROM internet_plans WHERE id = ?').get(parsed.data.planId);
      if (!plan) {
        return reply.status(404).send({ error: 'Plano nao encontrado' });
      }
    }

    db.prepare(`
      UPDATE services
      SET client_id = ?,
          plan_id = ?,
          monthly_value_centavos = CAST(ROUND(? * 100) AS INTEGER),
          activation_date = ?,
          due_day = ?,
          status = ?,
          technical_notes = ?,
          audiovisual_mode = ?,
          audiovisual_monthly_centavos = CAST(ROUND(? * 100) AS INTEGER),
          audiovisual_annual_centavos = CAST(ROUND(? * 100) AS INTEGER),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      parsed.data.clientId,
      parsed.data.planId || null,
      parsed.data.monthlyValueCve,
      parsed.data.activationDate || null,
      parsed.data.dueDay,
      parsed.data.status,
      parsed.data.technicalNotes || null,
      parsed.data.audiovisualMode,
      parsed.data.audiovisualMonthlyCve,
      parsed.data.audiovisualAnnualCve,
      id
    );

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

    const db = getSqliteDatabase();
    const service = db.prepare(`
      SELECT s.id, c.full_name AS clientName
      FROM services s
      JOIN clients c ON c.id = s.client_id
      WHERE s.id = ?
    `).get(id) as { id: number; clientName: string } | undefined;
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }

    // Pegada fiscal: qualquer payment (mesmo anulada) bloqueia o delete.
    const billed = db.prepare('SELECT COUNT(*) AS total FROM payments WHERE service_id = ?').get(id) as { total: number };
    if (billed.total > 0) {
      return reply.status(409).send({
        error: 'Este servico ja tem faturas emitidas. Cancele o servico em vez de o apagar.'
      });
    }

    // Stock líquido a repor por catálogo: Σ(saida) − Σ(devolucao) deste serviço.
    const restoreStock = db.prepare(`
      SELECT catalog_id AS catalogId,
             SUM(CASE WHEN type = 'saida' THEN quantity
                      WHEN type = 'devolucao' THEN -quantity
                      ELSE 0 END) AS delta
      FROM stock_movements
      WHERE service_id = ? AND catalog_id IS NOT NULL
      GROUP BY catalog_id
    `).all(id) as Array<{ catalogId: number; delta: number }>;

    const run = db.transaction(() => {
      for (const row of restoreStock) {
        if (row.delta && row.delta !== 0) {
          db.prepare(`
            UPDATE equipment_catalog
            SET stock_total = stock_total + ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(row.delta, row.catalogId);
        }
      }
      db.prepare('DELETE FROM stock_movements WHERE service_id = ?').run(id);
      db.prepare('UPDATE work_orders SET service_id = NULL WHERE service_id = ?').run(id);
      db.prepare('UPDATE sms_outbox SET service_id = NULL WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM service_install_costs WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM service_material_lines WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM service_events WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM service_device_assignments WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM services WHERE id = ?').run(id);
    });
    run();

    recordAudit(request, {
      action: 'delete',
      entityType: 'service',
      entityId: id,
      summary: `Apagou servico ${id} (${service.clientName})`,
      metadata: { clientName: service.clientName, restoredStock: restoreStock }
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
        py.amount_centavos / 100.0 AS amountCve,
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
    const db = getSqliteDatabase();
    const referenceMonth = parsed.data.referenceMonth;

    const rows = db.prepare(`
      SELECT
        py.id,
        py.client_id AS clientId,
        c.full_name AS clientName,
        c.client_code AS clientCode,
        py.amount_centavos / 100.0 AS amountCve,
        py.due_date AS dueDate,
        py.invoice_number AS invoiceNumber,
        py.status
      FROM payments py
      JOIN clients c ON c.id = py.client_id
      WHERE py.reference_month = ?
      ORDER BY c.full_name
    `).all(referenceMonth) as Array<{
      id: number;
      clientId: number;
      clientName: string;
      clientCode: string | null;
      amountCve: number;
      dueDate: string;
      invoiceNumber: string | null;
      status: 'pending' | 'paid' | 'overdue' | 'cancelled';
    }>;

    const eligible = rows.filter((r) => r.status === 'pending' || r.status === 'overdue');
    const paidLocked = rows.filter((r) => r.status === 'paid');
    const cancelledKept = rows.filter((r) => r.status === 'cancelled');

    return {
      referenceMonth,
      total: rows.length,
      eligibleCount: eligible.length,
      paidLockedCount: paidLocked.length,
      cancelledCount: cancelledKept.length,
      totalCve: eligible.reduce((sum, r) => sum + r.amountCve, 0),
      eligible,
      paidLocked: paidLocked.map((r) => ({
        id: r.id,
        clientName: r.clientName,
        clientCode: r.clientCode,
        invoiceNumber: r.invoiceNumber,
        amountCve: r.amountCve
      }))
    };
  });

  app.post('/api/billing/reverse-monthly', billingWrite, async (request, reply) => {
    const parsed = monthSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Mes de referencia invalido' });
    }
    const db = getSqliteDatabase();
    const referenceMonth = parsed.data.referenceMonth;

    const eligibleStmt = db.prepare(`
      SELECT id, invoice_number AS invoiceNumber
      FROM payments
      WHERE reference_month = ? AND status IN ('pending', 'overdue')
    `);
    const deleteLinesStmt = db.prepare(`
      DELETE FROM payment_lines WHERE payment_id IN (
        SELECT id FROM payments WHERE reference_month = ? AND status IN ('pending', 'overdue')
      )
    `);
    const deleteStmt = db.prepare(`
      DELETE FROM payments
      WHERE reference_month = ? AND status IN ('pending', 'overdue')
    `);

    const eligibleRows = eligibleStmt.all(referenceMonth) as Array<{ id: number; invoiceNumber: string | null }>;
    const result = db.transaction(() => {
      deleteLinesStmt.run(referenceMonth); // filhos primeiro (FK)
      return deleteStmt.run(referenceMonth);
    })();

    recordAudit(request, {
      action: 'reverse_monthly',
      entityType: 'billing',
      entityId: referenceMonth,
      summary: `Reverteu cobranca mensal ${referenceMonth}`,
      metadata: {
        referenceMonth,
        reversed: result.changes,
        invoiceNumbers: eligibleRows.map((r) => r.invoiceNumber).filter(Boolean)
      }
    });

    return {
      referenceMonth,
      reversed: result.changes
    };
  });

  app.post('/api/payments/:id/revert', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const db = getSqliteDatabase();
    const payment = db.prepare(`
      SELECT id, status, reference_month AS referenceMonth, invoice_number AS invoiceNumber, client_id AS clientId
      FROM payments WHERE id = ?
    `).get(id) as {
      id: number;
      status: 'pending' | 'paid' | 'overdue' | 'cancelled';
      referenceMonth: string;
      invoiceNumber: string | null;
      clientId: number;
    } | undefined;

    if (!payment) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    if (payment.status === 'paid') {
      return reply.status(400).send({ error: 'Pagamento pago nao pode ser revertido. Use anular.' });
    }
    if (payment.status === 'cancelled') {
      return reply.status(400).send({ error: 'Pagamento ja esta anulado. Nada a reverter.' });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM payment_lines WHERE payment_id = ?').run(id); // filhos primeiro (FK)
      db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    })();

    recordAudit(request, {
      action: 'revert',
      entityType: 'payment',
      entityId: id,
      summary: `Reverteu pagamento ${id}`,
      metadata: {
        referenceMonth: payment.referenceMonth,
        invoiceNumber: payment.invoiceNumber,
        clientId: payment.clientId
      }
    });

    return { id, reverted: true };
  });

  app.post('/api/payments/:id/regenerate', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const db = getSqliteDatabase();
    const payment = db.prepare(`
      SELECT
        py.id,
        py.status,
        py.client_id AS clientId,
        py.service_id AS serviceId,
        py.reference_month AS referenceMonth,
        s.monthly_value_centavos / 100.0 AS monthlyValueCve,
        s.audiovisual_mode AS audiovisualMode,
        s.audiovisual_monthly_centavos / 100.0 AS audiovisualMonthlyCve,
        s.audiovisual_annual_centavos / 100.0 AS audiovisualAnnualCve,
        s.status AS serviceStatus,
        c.status AS clientStatus
      FROM payments py
      JOIN services s ON s.id = py.service_id
      JOIN clients c ON c.id = py.client_id
      WHERE py.id = ?
    `).get(id) as {
      id: number;
      status: 'pending' | 'paid' | 'overdue' | 'cancelled';
      clientId: number;
      serviceId: number;
      referenceMonth: string;
      monthlyValueCve: number;
      audiovisualMode: 'none' | 'monthly' | 'annual';
      audiovisualMonthlyCve: number;
      audiovisualAnnualCve: number;
      serviceStatus: 'active' | 'suspended' | 'cancelled';
      clientStatus: 'active' | 'suspended' | 'cancelled';
    } | undefined;

    if (!payment) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    if (payment.status !== 'cancelled') {
      return reply.status(400).send({ error: 'Apenas pagamentos anulados podem regenerar mensalidade' });
    }
    if (payment.serviceStatus !== 'active') {
      return reply.status(400).send({ error: 'Servico cancelado nao pode regenerar mensalidade' });
    }
    if (payment.clientStatus === 'cancelled') {
      return reply.status(400).send({ error: 'Cliente cancelado nao pode regenerar mensalidade' });
    }

    const activePayment = db.prepare(`
      SELECT id
      FROM payments
      WHERE service_id = ? AND reference_month = ? AND status != 'cancelled'
    `).get(payment.serviceId, payment.referenceMonth);
    if (activePayment) {
      return reply.status(400).send({ error: 'Ja existe uma mensalidade ativa para este servico e mes' });
    }

    // Reconstrói a composição a partir do serviço — mensal (internet + audiovisual)
    // ou anuidade audiovisual, conforme a competência. Mesma fonte da geração
    // original, para o total regenerado nunca divergir.
    const config = loadAudiovisualConfig(db);
    const lines: BillingLine[] = isAudiovisualAnnualReference(payment.referenceMonth)
      ? (() => {
          const annual = payment.audiovisualAnnualCve > 0 ? payment.audiovisualAnnualCve : config.annualCve;
          return annual > 0 ? [{ kind: 'audiovisual' as const, description: config.label, amountCve: annual }] : [];
        })()
      : buildMonthlyServiceLines(payment, config.label);
    const amountCve = sumLines(lines);
    if (amountCve <= 0) {
      return reply.status(400).send({ error: 'Servico sem valor a regenerar' });
    }

    const issueIso = todayIso();
    const dueDate = dueDateFromIssue(issueIso);
    const insertLine = db.prepare(`
      INSERT INTO payment_lines (payment_id, kind, description, amount_centavos, sort_order)
      VALUES (?, ?, ?, CAST(ROUND(? * 100) AS INTEGER), ?)
    `);
    const regenerated = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT INTO payments (
          client_id, service_id, reference_month, amount_centavos, due_date,
          status, invoice_number, invoice_date, created_at, updated_at
        )
        VALUES (?, ?, ?, CAST(ROUND(? * 100) AS INTEGER), ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
      `).run(payment.clientId, payment.serviceId, payment.referenceMonth, amountCve, dueDate);
      const regeneratedId = Number(inserted.lastInsertRowid);
      const invoiceNumber = nextNumber('invoice', regeneratedId);
      db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ?').run(invoiceNumber, regeneratedId);
      lines.forEach((line, index) => insertLine.run(regeneratedId, line.kind, line.description, line.amountCve, index));
      return { regeneratedId, invoiceNumber };
    })();

    recordAudit(request, {
      action: 'regenerate',
      entityType: 'payment',
      entityId: regenerated.regeneratedId,
      summary: `Regenerou mensalidade anulada ${id} como ${regenerated.regeneratedId}`,
      metadata: {
        regeneratedFromId: id,
        referenceMonth: payment.referenceMonth,
        serviceId: payment.serviceId,
        amountCve,
        invoiceNumber: regenerated.invoiceNumber
      }
    });

    return reply.status(201).send({
      id: regenerated.regeneratedId,
      regeneratedFromId: id,
      referenceMonth: payment.referenceMonth,
      amountCve,
      dueDate,
      status: 'pending',
      invoiceNumber: regenerated.invoiceNumber
    });
  });

  app.post('/api/payments/:id/pay', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = paySchema.safeParse(request.body || {});
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const db = getSqliteDatabase();
    const payment = db.prepare('SELECT id, status FROM payments WHERE id = ?').get(id) as { id: number; status: 'pending' | 'paid' | 'overdue' | 'cancelled' } | undefined;
    if (!payment) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    if (payment.status === 'cancelled') {
      return reply.status(400).send({ error: 'Pagamento anulado nao pode ser pago' });
    }

    const receiptNumber = nextNumber('receipt', id);
    db.prepare(`
      UPDATE payments
      SET status = 'paid',
          payment_method = ?,
          payment_date = ?,
          receipt_number = COALESCE(receipt_number, ?),
          receipt_date = COALESCE(receipt_date, date('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(parsed.data.paymentMethod, parsed.data.paymentDate || new Date().toISOString().slice(0, 10), receiptNumber, id);

    recordAudit(request, {
      action: 'pay',
      entityType: 'payment',
      entityId: id,
      summary: `Marcou pagamento ${id} como pago`,
      metadata: { paymentMethod: parsed.data.paymentMethod }
    });
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  });

  app.post('/api/payments/:id/overdue', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const db = getSqliteDatabase();
    const payment = db.prepare('SELECT id, status FROM payments WHERE id = ?')
      .get(id) as { id: number; status: 'pending' | 'paid' | 'overdue' | 'cancelled' } | undefined;
    if (!payment) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    if (payment.status === 'paid') {
      return reply.status(400).send({ error: 'Pagamento pago nao pode ser marcado em atraso' });
    }
    if (payment.status === 'cancelled') {
      return reply.status(400).send({ error: 'Pagamento anulado nao pode ser marcado em atraso' });
    }

    db.prepare(`
      UPDATE payments
      SET status = 'overdue',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);

    recordAudit(request, {
      action: 'mark_overdue',
      entityType: 'payment',
      entityId: id,
      summary: `Marcou pagamento ${id} em atraso`
    });
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  });

  app.post('/api/payments/:id/cancel', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = cancelSchema.safeParse(request.body || {});
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    try {
      const db = getSqliteDatabase();
      const payment = db.prepare(`
        SELECT id, status, notes, amount_centavos / 100.0 AS amountCve, invoice_number AS invoiceNumber,
               receipt_number AS receiptNumber, reference_month AS referenceMonth
        FROM payments WHERE id = ?
      `).get(id) as {
        id: number;
        status: 'pending' | 'paid' | 'overdue' | 'cancelled';
        notes: string | null;
        amountCve: number;
        invoiceNumber: string | null;
        receiptNumber: string | null;
        referenceMonth: string;
      } | undefined;
      if (!payment) {
        return reply.status(404).send({ error: 'Pagamento nao encontrado' });
      }
      if (payment.status === 'cancelled') {
        return reply.status(400).send({ error: 'Pagamento ja esta anulado' });
      }

      const reason = parsed.data.reason?.trim() || '';
      const wasPaid = payment.status === 'paid';
      if (wasPaid && reason.length < 10) {
        return reply.status(400).send({
          error: 'Anular pagamento ja registado exige um motivo detalhado (minimo 10 caracteres).'
        });
      }

      const stampedReason = reason
        ? wasPaid
          ? `[ANULACAO POS-PAGAMENTO] ${reason}`
          : reason
        : '';
      const notes = stampedReason
        ? [payment.notes?.trim(), stampedReason].filter(Boolean).join('\n')
        : payment.notes;

      db.prepare(`
        UPDATE payments
        SET status = 'cancelled',
            notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(notes || null, id);

      recordAudit(request, {
        action: wasPaid ? 'cancel_paid' : 'cancel',
        entityType: 'payment',
        entityId: id,
        summary: wasPaid
          ? `Anulou pagamento ja registado ${id} (FT ${payment.invoiceNumber || '-'}, REC ${payment.receiptNumber || '-'})`
          : `Anulou pagamento ${id}`,
        metadata: {
          reason,
          priorStatus: payment.status,
          invoiceNumber: payment.invoiceNumber,
          receiptNumber: payment.receiptNumber,
          amountCve: payment.amountCve,
          referenceMonth: payment.referenceMonth
        }
      });
      return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    } catch (err) {
      request.log.error({ err, paymentId: id }, 'cancel payment failed');
      return reply.status(500).send({
        error: 'Falha ao anular pagamento',
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  });
}
