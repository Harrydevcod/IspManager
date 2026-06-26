import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { runRecurringExpensesIfDue } from '../lib/recurring-expenses';
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
  'aluguer',
  'energia',
  'manutencao',
  'deslocacoes',
  'reparacoes',
  'outros'
]);

const templateSchema = z.object({
  name: z.string().trim().min(1).max(180),
  category: expenseCategory.default('outros'),
  amountCve: z.coerce.number().min(0),
  dayOfMonth: z.coerce.number().int().min(1).max(28).default(1),
  supplier: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  investmentId: z.coerce.number().int().positive().optional().nullable(),
  zone: z.string().trim().max(120).optional().nullable(),
  clientId: z.coerce.number().int().positive().optional().nullable(),
  active: z.coerce.boolean().default(true)
});

type TemplateRow = {
  id: number;
  name: string;
  category: string;
  amountCve: number;
  dayOfMonth: number;
  supplier: string | null;
  notes: string | null;
  investmentId: number | null;
  investmentName: string | null;
  zone: string | null;
  clientId: number | null;
  clientName: string | null;
  active: number;
  lastGeneratedMonth: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function registerExpenseTemplateRoutes(app: FastifyInstance) {
  const canWrite = { preHandler: requireRole(['admin', 'operator']) };
  const canRead = { preHandler: requireAuth() };

  app.get('/api/expense-templates', canRead, async () => {
    const db = getSqliteDatabase();
    const rows = db.prepare(`
      SELECT
        t.id,
        t.name,
        t.category,
        t.amount_centavos / 100.0 AS amountCve,
        t.day_of_month AS dayOfMonth,
        t.supplier,
        t.notes,
        t.investment_id AS investmentId,
        i.name AS investmentName,
        t.zone,
        t.client_id AS clientId,
        c.full_name AS clientName,
        t.active,
        t.last_generated_month AS lastGeneratedMonth,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt
      FROM expense_templates t
      LEFT JOIN investments i ON i.id = t.investment_id
      LEFT JOIN clients c ON c.id = t.client_id
      ORDER BY t.active DESC, t.day_of_month ASC, t.name ASC
    `).all() as TemplateRow[];

    const totalActiveMonthlyCve = rows
      .filter((r) => r.active === 1)
      .reduce((sum, r) => sum + Number(r.amountCve || 0), 0);

    return { rows, totals: { count: rows.length, totalActiveMonthlyCve } };
  });

  app.post('/api/expense-templates', canWrite, async (request, reply) => {
    const parsed = templateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados do template invalidos' });
    }
    const input = parsed.data;
    const db = getSqliteDatabase();
    const info = db.prepare(`
      INSERT INTO expense_templates (
        name, category, amount_centavos, day_of_month, supplier, notes,
        investment_id, zone, client_id, active, created_by
      ) VALUES (?, ?, CAST(ROUND(? * 100) AS INTEGER), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.category,
      input.amountCve,
      input.dayOfMonth,
      input.supplier ?? null,
      input.notes ?? null,
      input.investmentId ?? null,
      input.zone ?? null,
      input.clientId ?? null,
      input.active ? 1 : 0,
      request.user?.id ?? null
    );
    const newId = Number(info.lastInsertRowid);
    recordAudit(request, {
      action: 'create',
      entityType: 'expense_template',
      entityId: newId,
      summary: `Criou template recorrente ${input.name}`,
      metadata: { category: input.category, amountCve: input.amountCve, dayOfMonth: input.dayOfMonth }
    });
    return reply.status(201).send({ id: newId });
  });

  app.put('/api/expense-templates/:id', canWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Id invalido' });
    const parsed = templateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Dados do template invalidos' });
    const input = parsed.data;
    const db = getSqliteDatabase();
    const info = db.prepare(`
      UPDATE expense_templates SET
        name = ?, category = ?, amount_centavos = CAST(ROUND(? * 100) AS INTEGER), day_of_month = ?,
        supplier = ?, notes = ?, investment_id = ?, zone = ?, client_id = ?,
        active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.name,
      input.category,
      input.amountCve,
      input.dayOfMonth,
      input.supplier ?? null,
      input.notes ?? null,
      input.investmentId ?? null,
      input.zone ?? null,
      input.clientId ?? null,
      input.active ? 1 : 0,
      id
    );
    if (info.changes === 0) return reply.status(404).send({ error: 'Template nao encontrado' });
    recordAudit(request, {
      action: 'update',
      entityType: 'expense_template',
      entityId: id,
      summary: `Atualizou template ${input.name}`,
      metadata: { active: input.active }
    });
    return { ok: true };
  });

  app.delete('/api/expense-templates/:id', canWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Id invalido' });
    const db = getSqliteDatabase();
    const existing = db.prepare('SELECT name FROM expense_templates WHERE id = ?').get(id) as { name: string } | undefined;
    if (!existing) return reply.status(404).send({ error: 'Template nao encontrado' });
    db.prepare('DELETE FROM expense_templates WHERE id = ?').run(id);
    recordAudit(request, {
      action: 'delete',
      entityType: 'expense_template',
      entityId: id,
      summary: `Apagou template ${existing.name}`
    });
    return { ok: true };
  });

  app.post('/api/expense-templates/run', canWrite, async (request) => {
    const result = runRecurringExpensesIfDue();
    recordAudit(request, {
      action: 'run',
      entityType: 'expense_template',
      summary: 'ran' in result
        ? `Gerou ${result.generated} despesa(s) recorrente(s) para ${result.month}`
        : `Recorrentes saltadas: ${result.reason}`,
      metadata: result
    });
    return result;
  });
}
