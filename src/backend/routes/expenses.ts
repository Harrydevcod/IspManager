import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { requireAuth, requireRole } from './auth';

const expenseCategory = z.enum([
  'equipamento',
  'infraestrutura',
  'salarios',
  'marketing',
  'impostos',
  'licencas',
  'combustivel',
  'banda_internet',
  'outros'
]);

const expenseSchema = z.object({
  category: expenseCategory.default('outros'),
  description: z.string().trim().min(1).max(240),
  amountCve: z.coerce.number().min(0),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  referenceMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  supplier: z.string().trim().max(160).optional().nullable(),
  invoiceReference: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  investmentId: z.coerce.number().int().positive().optional().nullable(),
  zone: z.string().trim().max(120).optional().nullable(),
  clientId: z.coerce.number().int().positive().optional().nullable()
});

const listQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  year: z.string().regex(/^\d{4}$/).optional(),
  category: expenseCategory.optional(),
  supplier: z.string().trim().max(160).optional(),
  investmentId: z.coerce.number().int().positive().optional(),
  zone: z.string().trim().max(120).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  allocation: z.enum(['allocated', 'unallocated']).optional()
});

type ExpenseInput = z.infer<typeof expenseSchema>;

function deriveReferenceMonth(input: ExpenseInput): string {
  return input.referenceMonth || input.expenseDate.slice(0, 7);
}

type ExpenseRow = {
  id: number;
  category: string;
  description: string;
  amountCve: number;
  expenseDate: string;
  referenceMonth: string;
  supplier: string | null;
  invoiceReference: string | null;
  notes: string | null;
  investmentId: number | null;
  investmentName: string | null;
  zone: string | null;
  clientId: number | null;
  clientName: string | null;
  createdAt: string;
  updatedAt: string;
};

type CategoryTotal = { category: string; count: number; totalCve: number };

export async function registerExpenseRoutes(app: FastifyInstance) {
  const canWrite = { preHandler: requireRole(['admin', 'operator']) };
  const canRead = { preHandler: requireAuth() };

  app.get('/api/expenses', canRead, async (request) => {
    const filter = listQuerySchema.safeParse(request.query || {});
    if (!filter.success) {
      return { rows: [], totals: { count: 0, totalCve: 0, byCategory: [] as CategoryTotal[] } };
    }

    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.data.month) {
      where.push('e.reference_month = @month');
      params.month = filter.data.month;
    } else if (filter.data.year) {
      where.push('e.reference_month >= @from AND e.reference_month <= @to');
      params.from = `${filter.data.year}-01`;
      params.to = `${filter.data.year}-12`;
    }
    if (filter.data.category) {
      where.push('e.category = @category');
      params.category = filter.data.category;
    }
    if (filter.data.supplier) {
      where.push('e.supplier LIKE @supplier');
      params.supplier = `%${filter.data.supplier}%`;
    }
    if (filter.data.investmentId) {
      where.push('e.investment_id = @investmentId');
      params.investmentId = filter.data.investmentId;
    }
    if (filter.data.zone) {
      where.push('e.zone = @zone');
      params.zone = filter.data.zone;
    }
    if (filter.data.clientId) {
      where.push('e.client_id = @clientId');
      params.clientId = filter.data.clientId;
    }
    if (filter.data.allocation === 'allocated') {
      where.push('(e.investment_id IS NOT NULL OR e.zone IS NOT NULL OR e.client_id IS NOT NULL)');
    } else if (filter.data.allocation === 'unallocated') {
      where.push('e.investment_id IS NULL AND e.zone IS NULL AND e.client_id IS NULL');
    }

    const db = getSqliteDatabase();
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT
        e.id,
        e.category,
        e.description,
        e.amount_cve AS amountCve,
        e.expense_date AS expenseDate,
        e.reference_month AS referenceMonth,
        e.supplier,
        e.invoice_reference AS invoiceReference,
        e.notes,
        e.investment_id AS investmentId,
        i.name AS investmentName,
        e.zone,
        e.client_id AS clientId,
        c.full_name AS clientName,
        e.created_at AS createdAt,
        e.updated_at AS updatedAt
      FROM expenses e
      LEFT JOIN investments i ON i.id = e.investment_id
      LEFT JOIN clients c ON c.id = e.client_id
      ${whereSql}
      ORDER BY e.expense_date DESC, e.id DESC
    `).all(params) as ExpenseRow[];

    const totalCve = rows.reduce((sum, row) => sum + Number(row.amountCve || 0), 0);
    const byCategoryMap = rows.reduce((map, row) => {
      const current = map.get(row.category) || { category: row.category, count: 0, totalCve: 0 };
      current.count += 1;
      current.totalCve += Number(row.amountCve || 0);
      map.set(row.category, current);
      return map;
    }, new Map<string, CategoryTotal>());

    return {
      rows,
      totals: {
        count: rows.length,
        totalCve,
        byCategory: [...byCategoryMap.values()].sort((a, b) => b.totalCve - a.totalCve)
      }
    };
  });

  app.post('/api/expenses', canWrite, async (request, reply) => {
    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados da despesa invalidos' });
    }
    const input = parsed.data;
    const referenceMonth = deriveReferenceMonth(input);

    const db = getSqliteDatabase();
    const info = db.prepare(`
      INSERT INTO expenses (
        category, description, amount_cve, expense_date, reference_month,
        supplier, invoice_reference, notes, investment_id, zone, client_id, created_by
      )
      VALUES (@category, @description, @amountCve, @expenseDate, @referenceMonth,
              @supplier, @invoiceReference, @notes, @investmentId, @zone, @clientId, @createdBy)
    `).run({
      category: input.category,
      description: input.description,
      amountCve: input.amountCve,
      expenseDate: input.expenseDate,
      referenceMonth,
      supplier: input.supplier ?? null,
      invoiceReference: input.invoiceReference ?? null,
      notes: input.notes ?? null,
      investmentId: input.investmentId ?? null,
      zone: input.zone ?? null,
      clientId: input.clientId ?? null,
      createdBy: request.user?.id ?? null
    });

    const newId = Number(info.lastInsertRowid);
    recordAudit(request, {
      action: 'create',
      entityType: 'expense',
      entityId: newId,
      summary: `Registou despesa ${input.description}`,
      metadata: { category: input.category, amountCve: input.amountCve, referenceMonth }
    });

    return reply.status(201).send({ id: newId });
  });

  app.put('/api/expenses/:id', canWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Id invalido' });
    }
    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados da despesa invalidos' });
    }
    const input = parsed.data;
    const referenceMonth = deriveReferenceMonth(input);

    const db = getSqliteDatabase();
    const info = db.prepare(`
      UPDATE expenses SET
        category = @category,
        description = @description,
        amount_cve = @amountCve,
        expense_date = @expenseDate,
        reference_month = @referenceMonth,
        supplier = @supplier,
        invoice_reference = @invoiceReference,
        notes = @notes,
        investment_id = @investmentId,
        zone = @zone,
        client_id = @clientId,
        updated_at = datetime('now')
      WHERE id = @id
    `).run({
      id,
      category: input.category,
      description: input.description,
      amountCve: input.amountCve,
      expenseDate: input.expenseDate,
      referenceMonth,
      supplier: input.supplier ?? null,
      invoiceReference: input.invoiceReference ?? null,
      notes: input.notes ?? null,
      investmentId: input.investmentId ?? null,
      zone: input.zone ?? null,
      clientId: input.clientId ?? null
    });

    if (info.changes === 0) {
      return reply.status(404).send({ error: 'Despesa nao encontrada' });
    }

    recordAudit(request, {
      action: 'update',
      entityType: 'expense',
      entityId: id,
      summary: `Atualizou despesa ${input.description}`,
      metadata: { category: input.category, amountCve: input.amountCve, referenceMonth }
    });

    return { ok: true };
  });

  app.delete('/api/expenses/:id', canWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Id invalido' });
    }

    const db = getSqliteDatabase();
    const existing = db.prepare(`
      SELECT description, category, amount_cve AS amountCve, reference_month AS referenceMonth
      FROM expenses WHERE id = ?
    `).get(id) as
      | { description: string; category: string; amountCve: number; referenceMonth: string }
      | undefined;
    if (!existing) {
      return reply.status(404).send({ error: 'Despesa nao encontrada' });
    }

    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);

    recordAudit(request, {
      action: 'delete',
      entityType: 'expense',
      entityId: id,
      summary: `Apagou despesa ${existing.description}`,
      metadata: {
        category: existing.category,
        amountCve: existing.amountCve,
        referenceMonth: existing.referenceMonth
      }
    });

    return { ok: true };
  });
}
