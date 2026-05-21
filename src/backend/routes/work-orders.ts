import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { requireAuth, requireRole } from './auth';

const STATUSES = ['aguarda', 'agendada', 'em_curso', 'concluida', 'cancelada'] as const;
const PRIORITIES = ['baixa', 'media', 'alta'] as const;
const EVENT_TYPES = ['instalacao', 'manutencao', 'troca_equipamento', 'visita', 'alteracao_servico'] as const;

const createSchema = z.object({
  serviceId: z.coerce.number().int().positive().optional().nullable(),
  title: z.string().trim().min(1).max(140),
  description: z.string().trim().optional().nullable(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  eventType: z.enum(EVENT_TYPES).optional().nullable(),
  assignedTo: z.string().trim().optional().nullable(),
  scheduledAt: z.string().trim().optional().nullable()
});

const patchSchema = z.object({
  serviceId: z.coerce.number().int().positive().optional().nullable(),
  title: z.string().trim().min(1).max(140).optional(),
  description: z.string().trim().optional().nullable(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  eventType: z.enum(EVENT_TYPES).optional().nullable(),
  assignedTo: z.string().trim().optional().nullable(),
  scheduledAt: z.string().trim().optional().nullable(),
  completionNotes: z.string().trim().optional().nullable()
});

type WorkOrderRow = {
  id: number;
  serviceId: number | null;
  clientId: number | null;
  clientName: string | null;
  clientCode: string | null;
  planName: string | null;
  title: string;
  description: string | null;
  status: typeof STATUSES[number];
  priority: typeof PRIORITIES[number];
  eventType: typeof EVENT_TYPES[number] | null;
  assignedTo: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completionNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

function selectOrders(filter: string, params: unknown[] = []) {
  return `
    SELECT
      w.id,
      w.service_id AS serviceId,
      s.client_id AS clientId,
      c.full_name AS clientName,
      c.client_code AS clientCode,
      p.name AS planName,
      w.title,
      w.description,
      w.status,
      w.priority,
      w.event_type AS eventType,
      w.assigned_to AS assignedTo,
      w.scheduled_at AS scheduledAt,
      w.started_at AS startedAt,
      w.completed_at AS completedAt,
      w.completion_notes AS completionNotes,
      w.created_at AS createdAt,
      w.updated_at AS updatedAt
    FROM work_orders w
    LEFT JOIN services s ON s.id = w.service_id
    LEFT JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    ${filter}
    ORDER BY
      CASE w.priority WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
      COALESCE(w.scheduled_at, w.created_at) ASC,
      w.id DESC
  `;
}

export async function registerWorkOrderRoutes(app: FastifyInstance) {
  const canWriteWorkOrders = { preHandler: requireRole(['admin', 'operator', 'technician']) };

  app.get('/api/work-orders', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    const rows = db.prepare(selectOrders('')).all() as WorkOrderRow[];
    return { items: rows };
  });

  app.get('/api/work-orders/board', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    const rows = db.prepare(selectOrders('')).all() as WorkOrderRow[];

    const columns = STATUSES.reduce<Record<string, WorkOrderRow[]>>((acc, status) => {
      acc[status] = [];
      return acc;
    }, {});
    let openCount = 0;
    for (const row of rows) {
      columns[row.status].push(row);
      if (row.status !== 'concluida' && row.status !== 'cancelada') {
        openCount += 1;
      }
    }

    return {
      columns: STATUSES.map((status) => ({ status, items: columns[status] })),
      totals: {
        total: rows.length,
        open: openCount,
        byStatus: STATUSES.reduce<Record<string, number>>((acc, status) => {
          acc[status] = columns[status].length;
          return acc;
        }, {})
      }
    };
  });

  app.get('/api/work-orders/:id', { preHandler: requireAuth() }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'OS invalida' });
    }
    const db = getSqliteDatabase();
    const row = db.prepare(selectOrders('WHERE w.id = ?')).get(id);
    if (!row) {
      return reply.status(404).send({ error: 'OS nao encontrada' });
    }
    return row;
  });

  app.post('/api/work-orders', canWriteWorkOrders, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de OS invalidos' });
    }

    const db = getSqliteDatabase();
    if (parsed.data.serviceId) {
      const service = db.prepare('SELECT id FROM services WHERE id = ?').get(parsed.data.serviceId);
      if (!service) {
        return reply.status(400).send({ error: 'Servico inexistente' });
      }
    }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const status = parsed.data.status ?? 'aguarda';
    const startedAt = status === 'em_curso' ? now : null;
    const completedAt = status === 'concluida' ? now : null;

    const result = db.prepare(`
      INSERT INTO work_orders (
        service_id, title, description, status, priority, event_type,
        assigned_to, scheduled_at, started_at, completed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      parsed.data.serviceId ?? null,
      parsed.data.title,
      parsed.data.description ?? null,
      status,
      parsed.data.priority ?? 'media',
      parsed.data.eventType ?? null,
      parsed.data.assignedTo ?? null,
      parsed.data.scheduledAt ?? null,
      startedAt,
      completedAt
    );

    const created = db.prepare(selectOrders('WHERE w.id = ?')).get(result.lastInsertRowid) as WorkOrderRow;

    if (status === 'concluida' && created.serviceId && created.eventType) {
      db.prepare(`
        INSERT INTO service_events (service_id, event_type, notes)
        VALUES (?, ?, ?)
      `).run(created.serviceId, created.eventType, created.title);
    }

    recordAudit(request, {
      action: 'create',
      entityType: 'work_order',
      entityId: created.id,
      summary: `Criou OS ${created.title}`,
      metadata: { status: created.status, priority: created.priority, serviceId: created.serviceId }
    });
    return reply.status(201).send(created);
  });

  app.patch('/api/work-orders/:id', canWriteWorkOrders, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'OS invalida' });
    }
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de OS invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(selectOrders('WHERE w.id = ?')).get(id) as WorkOrderRow | undefined;
    if (!current) {
      return reply.status(404).send({ error: 'OS nao encontrada' });
    }

    if (parsed.data.serviceId) {
      const service = db.prepare('SELECT id FROM services WHERE id = ?').get(parsed.data.serviceId);
      if (!service) {
        return reply.status(400).send({ error: 'Servico inexistente' });
      }
    }

    const next = {
      serviceId: parsed.data.serviceId === undefined ? current.serviceId : parsed.data.serviceId,
      title: parsed.data.title ?? current.title,
      description: parsed.data.description === undefined ? current.description : parsed.data.description,
      status: parsed.data.status ?? current.status,
      priority: parsed.data.priority ?? current.priority,
      eventType: parsed.data.eventType === undefined ? current.eventType : parsed.data.eventType,
      assignedTo: parsed.data.assignedTo === undefined ? current.assignedTo : parsed.data.assignedTo,
      scheduledAt: parsed.data.scheduledAt === undefined ? current.scheduledAt : parsed.data.scheduledAt,
      completionNotes:
        parsed.data.completionNotes === undefined ? current.completionNotes : parsed.data.completionNotes
    };

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    let startedAt = current.startedAt;
    let completedAt = current.completedAt;

    if (next.status === 'em_curso' && !startedAt) {
      startedAt = now;
    }
    if (next.status === 'concluida') {
      if (!startedAt) startedAt = now;
      if (!completedAt) completedAt = now;
    }
    if (next.status === 'cancelada') {
      completedAt = completedAt ?? now;
    }
    if (next.status !== 'concluida' && next.status !== 'cancelada') {
      completedAt = null;
    }

    db.prepare(`
      UPDATE work_orders
      SET service_id = ?,
          title = ?,
          description = ?,
          status = ?,
          priority = ?,
          event_type = ?,
          assigned_to = ?,
          scheduled_at = ?,
          started_at = ?,
          completed_at = ?,
          completion_notes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      next.serviceId,
      next.title,
      next.description,
      next.status,
      next.priority,
      next.eventType,
      next.assignedTo,
      next.scheduledAt,
      startedAt,
      completedAt,
      next.completionNotes,
      id
    );

    const justCompleted = current.status !== 'concluida' && next.status === 'concluida';
    if (justCompleted && next.serviceId && next.eventType) {
      const noteParts: string[] = [next.title];
      if (next.completionNotes) noteParts.push(next.completionNotes);
      db.prepare(`
        INSERT INTO service_events (service_id, event_type, notes)
        VALUES (?, ?, ?)
      `).run(next.serviceId, next.eventType, noteParts.join(' — '));
    }

    const updated = db.prepare(selectOrders('WHERE w.id = ?')).get(id);
    recordAudit(request, {
      action: 'update',
      entityType: 'work_order',
      entityId: id,
      summary: `Atualizou OS ${next.title}`,
      metadata: { status: next.status, priority: next.priority, serviceId: next.serviceId }
    });
    return updated;
  });

  app.delete('/api/work-orders/:id', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'OS invalida' });
    }
    const db = getSqliteDatabase();
    const result = db.prepare('DELETE FROM work_orders WHERE id = ?').run(id);
    if (result.changes === 0) {
      return reply.status(404).send({ error: 'OS nao encontrada' });
    }
    recordAudit(request, {
      action: 'delete',
      entityType: 'work_order',
      entityId: id,
      summary: `Eliminou OS ${id}`
    });
    return reply.status(204).send();
  });
}
