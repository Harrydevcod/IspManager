import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { computeMonthlyBilling, dueDateFromIssue, generateMonthlyBilling, todayIso } from '../lib/billing';
import { nextDocumentNumber } from '../lib/numbering';
import { recordAudit } from '../lib/audit';
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

const serviceSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  planId: z.coerce.number().int().positive().optional().nullable(),
  monthlyValueCve: z.coerce.number().min(0),
  dueDay: z.coerce.number().int().min(1).max(31).default(1),
  activationDate: z.string().optional().nullable(),
  status: z.enum(['active', 'suspended', 'cancelled']).default('active'),
  technicalNotes: z.string().trim().optional().nullable()
});

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
        s.monthly_value_cve AS monthlyValueCve,
        s.due_day AS dueDay,
        s.status,
        s.activation_date AS activationDate,
        s.technical_notes AS technicalNotes
      FROM services s
      JOIN clients c ON c.id = s.client_id
      LEFT JOIN internet_plans p ON p.id = s.plan_id
      ORDER BY c.full_name
    `).all();
  });

  app.post('/api/services', billingWrite, async (request, reply) => {
    const parsed = serviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de servico invalidos' });
    }

    const db = getSqliteDatabase();
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

    const result = db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day,
        status, technical_notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      parsed.data.clientId,
      parsed.data.planId || null,
      parsed.data.monthlyValueCve,
      parsed.data.activationDate || null,
      parsed.data.dueDay,
      parsed.data.status,
      parsed.data.technicalNotes || null
    );

    recordAudit(request, {
      action: 'create',
      entityType: 'service',
      entityId: Number(result.lastInsertRowid),
      summary: `Criou servico para cliente ${parsed.data.clientId}`,
      metadata: { clientId: parsed.data.clientId, planId: parsed.data.planId ?? null, status: parsed.data.status }
    });
    return reply.status(201).send({ id: result.lastInsertRowid });
  });

  app.put('/api/services/:id', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = serviceSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de servico invalidos' });
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
          monthly_value_cve = ?,
          activation_date = ?,
          due_day = ?,
          status = ?,
          technical_notes = ?,
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
      id
    );

    recordAudit(request, {
      action: 'update',
      entityType: 'service',
      entityId: id,
      summary: `Atualizou servico ${id}`,
      metadata: { clientId: parsed.data.clientId, planId: parsed.data.planId ?? null, status: parsed.data.status }
    });
    return { ok: true };
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
    const db = getSqliteDatabase();
    const referenceMonth = parsed.data.referenceMonth;

    const rows = db.prepare(`
      SELECT
        py.id,
        py.client_id AS clientId,
        c.full_name AS clientName,
        c.client_code AS clientCode,
        py.amount_cve AS amountCve,
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
    const deleteStmt = db.prepare(`
      DELETE FROM payments
      WHERE reference_month = ? AND status IN ('pending', 'overdue')
    `);

    const eligibleRows = eligibleStmt.all(referenceMonth) as Array<{ id: number; invoiceNumber: string | null }>;
    const result = db.transaction(() => deleteStmt.run(referenceMonth))();

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

    db.prepare('DELETE FROM payments WHERE id = ?').run(id);

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
        s.monthly_value_cve AS amountCve,
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
      amountCve: number;
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

    const issueIso = todayIso();
    const dueDate = dueDateFromIssue(issueIso);
    const regenerated = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT INTO payments (
          client_id, service_id, reference_month, amount_cve, due_date,
          status, invoice_number, invoice_date, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
      `).run(payment.clientId, payment.serviceId, payment.referenceMonth, payment.amountCve, dueDate);
      const regeneratedId = Number(inserted.lastInsertRowid);
      const invoiceNumber = nextNumber('invoice', regeneratedId);
      db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ?').run(invoiceNumber, regeneratedId);
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
        amountCve: payment.amountCve,
        invoiceNumber: regenerated.invoiceNumber
      }
    });

    return reply.status(201).send({
      id: regenerated.regeneratedId,
      regeneratedFromId: id,
      referenceMonth: payment.referenceMonth,
      amountCve: payment.amountCve,
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
        SELECT id, status, notes, amount_cve AS amountCve, invoice_number AS invoiceNumber,
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
