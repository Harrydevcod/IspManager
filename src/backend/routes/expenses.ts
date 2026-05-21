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
  notes: z.string().trim().max(500).optional().nullable()
});

const listQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  year: z.string().regex(/^\d{4}$/).optional(),
  category: expenseCategory.optional(),
  supplier: z.string().trim().max(160).optional()
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
    const params: Record<string, string> = {};
    if (filter.data.month) {
      where.push('reference_month = @month');
      params.month = filter.data.month;
    } else if (filter.data.year) {
      where.push('reference_month >= @from AND reference_month <= @to');
      params.from = `${filter.data.year}-01`;
      params.to = `${filter.data.year}-12`;
    }
    if (filter.data.category) {
      where.push('category = @category');
      params.category = filter.data.category;
    }
    if (filter.data.supplier) {
      where.push('supplier LIKE @supplier');
      params.supplier = `%${filter.data.supplier}%`;
    }

    const db = getSqliteDatabase();
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT
        id,
        category,
        description,
        amount_cve AS amountCve,
        expense_date AS expenseDate,
        reference_month AS referenceMonth,
        supplier,
        invoice_reference AS invoiceReference,
        notes,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM expenses
      ${whereSql}
      ORDER BY expense_date DESC, id DESC
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
        supplier, invoice_reference, notes, created_by
      )
      VALUES (@category, @description, @amountCve, @expenseDate, @referenceMonth,
              @supplier, @invoiceReference, @notes, @createdBy)
    `).run({
      category: input.category,
      description: input.description,
      amountCve: input.amountCve,
      expenseDate: input.expenseDate,
      referenceMonth,
      supplier: input.supplier ?? null,
      invoiceReference: input.invoiceReference ?? null,
      notes: input.notes ?? null,
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
      notes: input.notes ?? null
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
