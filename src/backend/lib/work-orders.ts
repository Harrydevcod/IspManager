import type Database from 'better-sqlite3';

export const WORK_ORDER_STATUSES = ['aguarda', 'agendada', 'em_curso', 'concluida', 'cancelada'] as const;
export const WORK_ORDER_PRIORITIES = ['baixa', 'media', 'alta'] as const;
export const WORK_ORDER_EVENT_TYPES = ['instalacao', 'manutencao', 'troca_equipamento', 'visita', 'alteracao_servico'] as const;

export type NewWorkOrder = {
  serviceId?: number | null;
  title: string;
  description?: string | null;
  status?: typeof WORK_ORDER_STATUSES[number];
  priority?: typeof WORK_ORDER_PRIORITIES[number];
  eventType?: typeof WORK_ORDER_EVENT_TYPES[number] | null;
  assignedTo?: string | null;
  scheduledAt?: string | null;
  ticketId?: number | null;
};

/**
 * A única porta de criação de uma OS: a rota das OS e o "Criar OS" de um pedido de
 * assistência passam por aqui. Uma OS que já nasce concluída deixa o evento no histórico do
 * serviço, como a conclusão pela rota.
 */
export function createWorkOrder(db: Database.Database, input: NewWorkOrder): number {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const status = input.status ?? 'aguarda';
  const id = Number(db.prepare(`
    INSERT INTO work_orders (
      service_id, title, description, status, priority, event_type,
      assigned_to, scheduled_at, started_at, completed_at, ticket_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    input.serviceId ?? null,
    input.title,
    input.description ?? null,
    status,
    input.priority ?? 'media',
    input.eventType ?? null,
    input.assignedTo ?? null,
    input.scheduledAt ?? null,
    status === 'em_curso' ? now : null,
    status === 'concluida' ? now : null,
    input.ticketId ?? null
  ).lastInsertRowid);

  if (status === 'concluida' && input.serviceId && input.eventType) {
    db.prepare('INSERT INTO service_events (service_id, event_type, notes) VALUES (?, ?, ?)')
      .run(input.serviceId, input.eventType, input.title);
  }
  return id;
}

/** O evento no histórico do serviço que uma OS concluída deixa (rota, criação e telemóvel). */
export function recordWorkOrderCompletion(
  db: Database.Database,
  order: { serviceId: number | null; eventType: string | null; title: string; completionNotes: string | null }
): void {
  if (!order.serviceId || !order.eventType) return;
  const notes = [order.title, order.completionNotes].filter(Boolean).join(' — ');
  db.prepare('INSERT INTO service_events (service_id, event_type, notes) VALUES (?, ?, ?)').run(order.serviceId, order.eventType, notes);
}

export type CompleteWorkOrderResult = { ok: true } | { ok: false; reason: string };

/**
 * Concluir uma OS vinda do terreno. `completedAt` é a hora do terreno (data do
 * facto), não a da chegada ao desktop. Uma OS já concluída ou cancelada não se
 * reabre nem se conclui duas vezes.
 */
export function completeWorkOrder(
  db: Database.Database,
  id: number,
  input: { notes: string; completedAt: string }
): CompleteWorkOrderResult {
  const current = db.prepare(`
    SELECT service_id AS serviceId, event_type AS eventType, title, status, started_at AS startedAt
    FROM work_orders WHERE id = ?
  `).get(id) as { serviceId: number | null; eventType: string | null; title: string; status: string; startedAt: string | null } | undefined;
  if (!current) return { ok: false, reason: 'OS inexistente' };
  if (current.status === 'concluida') return { ok: false, reason: 'OS já estava concluída' };
  if (current.status === 'cancelada') return { ok: false, reason: 'OS cancelada' };

  db.prepare(`
    UPDATE work_orders
    SET status = 'concluida', started_at = COALESCE(started_at, ?), completed_at = ?, completion_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(input.completedAt, input.completedAt, input.notes, id);
  recordWorkOrderCompletion(db, { ...current, completionNotes: input.notes });
  return { ok: true };
}
