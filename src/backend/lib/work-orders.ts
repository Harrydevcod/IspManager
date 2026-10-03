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
