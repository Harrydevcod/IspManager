import type Database from 'better-sqlite3';
import { createWorkOrder } from './work-orders';

export const TICKET_CHANNELS = ['telefone', 'whatsapp', 'presencial', 'email', 'outro'] as const;
export const TICKET_CATEGORIES = ['sem_ligacao', 'lento', 'intermitente', 'equipamento', 'faturacao', 'outro'] as const;
export const TICKET_PRIORITIES = ['baixa', 'media', 'alta'] as const;
export const TICKET_STATUSES = ['aberto', 'em_curso', 'aguarda_cliente', 'resolvido', 'fechado'] as const;

export type TicketStatus = typeof TICKET_STATUSES[number];
type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const STATUS_LABEL: Record<TicketStatus, string> = {
  aberto: 'Aberto', em_curso: 'Em curso', aguarda_cliente: 'A aguardar o cliente', resolvido: 'Resolvido', fechado: 'Fechado'
};
/** Acabar um pedido diz sempre o que se fez: sem nota, o histórico fica mudo. */
const NEEDS_NOTE = new Set<TicketStatus>(['resolvido', 'fechado']);

function sqlNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const SELECT_TICKETS = `
  SELECT t.id, t.client_id AS clientId, c.client_code AS clientCode, c.full_name AS clientName,
         t.service_id AS serviceId, s.pppoe_username AS pppoeUsername, p.name AS planName,
         t.subject, t.channel, t.category, t.priority, t.status,
         t.opened_by AS openedById, ob.full_name AS openedByName,
         t.assigned_to AS assignedToId, au.full_name AS assignedToName,
         t.opened_at AS openedAt, t.first_response_at AS firstResponseAt,
         t.resolved_at AS resolvedAt, t.closed_at AS closedAt, t.updated_at AS updatedAt
  FROM support_tickets t
  JOIN clients c ON c.id = t.client_id
  LEFT JOIN services s ON s.id = t.service_id
  LEFT JOIN internet_plans p ON p.id = s.plan_id
  LEFT JOIN users ob ON ob.id = t.opened_by
  LEFT JOIN users au ON au.id = t.assigned_to`;

export type TicketRow = {
  id: number; clientId: number; clientCode: string; clientName: string;
  serviceId: number | null; pppoeUsername: string | null; planName: string | null;
  subject: string; channel: string; category: string; priority: string; status: TicketStatus;
  openedById: number | null; openedByName: string | null; assignedToId: number | null; assignedToName: string | null;
  openedAt: string; firstResponseAt: string | null; resolvedAt: string | null; closedAt: string | null; updatedAt: string;
};

export function listTickets(db: Database.Database, filter: { status?: TicketStatus; clientId?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) { where.push('t.status = ?'); params.push(filter.status); }
  if (filter.clientId) { where.push('t.client_id = ?'); params.push(filter.clientId); }
  const items = db.prepare(`${SELECT_TICKETS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE WHEN t.status IN ('resolvido','fechado') THEN 1 ELSE 0 END,
             CASE t.priority WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, t.opened_at DESC, t.id DESC`)
    .all(...params) as TicketRow[];
  return { items, metrics: ticketMetrics(db) };
}

/** O que o painel mostra por cima da lista; o tempo de resposta mede-se nos últimos 30 dias. */
export function ticketMetrics(db: Database.Database, now = sqlNow()) {
  const row = db.prepare(`SELECT
      SUM(status IN ('aberto','em_curso')) AS open,
      SUM(status = 'aguarda_cliente') AS waiting,
      SUM(resolved_at IS NOT NULL AND substr(resolved_at, 1, 7) = substr(?, 1, 7)) AS resolvedThisMonth,
      AVG(CASE WHEN first_response_at IS NOT NULL AND opened_at >= datetime(?, '-30 days')
        THEN (julianday(first_response_at) - julianday(opened_at)) * 86400 END) AS avgFirstResponseSeconds
    FROM support_tickets`).get(now, now) as Record<string, number | null>;
  return {
    open: row.open ?? 0,
    waiting: row.waiting ?? 0,
    resolvedThisMonth: row.resolvedThisMonth ?? 0,
    avgFirstResponseSeconds: row.avgFirstResponseSeconds === null ? null : Math.round(row.avgFirstResponseSeconds)
  };
}

export function getTicket(db: Database.Database, id: number) {
  const ticket = db.prepare(`${SELECT_TICKETS} WHERE t.id = ?`).get(id) as TicketRow | undefined;
  if (!ticket) return null;
  const entries = db.prepare(`SELECT e.id, e.kind, e.body, e.created_at AS createdAt, u.full_name AS authorName
    FROM support_ticket_entries e LEFT JOIN users u ON u.id = e.author_id
    WHERE e.ticket_id = ? ORDER BY e.id`).all(id);
  const workOrders = db.prepare(`SELECT id, title, status, assigned_to AS assignedTo, scheduled_at AS scheduledAt
    FROM work_orders WHERE ticket_id = ? ORDER BY id`).all(id);
  return { ...ticket, entries, workOrders };
}

function addEntryRow(db: Database.Database, ticketId: number, kind: 'nota' | 'mudanca_estado' | 'os_criada', body: string, authorId: number | null) {
  db.prepare('INSERT INTO support_ticket_entries (ticket_id, author_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, authorId, kind, body, sqlNow());
}

/** A primeira coisa feita depois de abrir o pedido é a primeira resposta. */
function touch(db: Database.Database, ticketId: number) {
  const now = sqlNow();
  db.prepare('UPDATE support_tickets SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?')
    .run(now, now, ticketId);
}

function exists(db: Database.Database, table: 'clients' | 'users', id: number) {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
}

export type OpenTicketInput = {
  clientId: number;
  serviceId?: number | null;
  subject: string;
  channel: typeof TICKET_CHANNELS[number];
  category: typeof TICKET_CATEGORIES[number];
  priority?: typeof TICKET_PRIORITIES[number];
  assignedTo?: number | null;
  note: string;
};

export function openTicket(db: Database.Database, input: OpenTicketInput, authorId: number | null): Result<number> {
  if (!exists(db, 'clients', input.clientId)) return { ok: false, status: 400, error: 'Cliente inexistente' };
  if (input.serviceId) {
    const service = db.prepare('SELECT client_id AS clientId FROM services WHERE id = ?').get(input.serviceId) as { clientId: number } | undefined;
    if (!service || service.clientId !== input.clientId) return { ok: false, status: 400, error: 'O serviço não é deste cliente' };
  }
  if (input.assignedTo && !exists(db, 'users', input.assignedTo)) return { ok: false, status: 400, error: 'Técnico inexistente' };
  const id = db.transaction(() => {
    const now = sqlNow();
    const ticketId = Number(db.prepare(`INSERT INTO support_tickets
        (client_id, service_id, subject, channel, category, priority, opened_by, assigned_to, opened_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.clientId, input.serviceId ?? null, input.subject, input.channel, input.category,
        input.priority ?? 'media', authorId, input.assignedTo ?? null, now, now).lastInsertRowid);
    // O relato do cliente não é resposta: não conta para o tempo até à 1.ª resposta.
    addEntryRow(db, ticketId, 'nota', input.note, authorId);
    return ticketId;
  })();
  return { ok: true, value: id };
}

export function addTicketNote(db: Database.Database, id: number, body: string, authorId: number | null): Result<null> {
  if (!db.prepare('SELECT 1 FROM support_tickets WHERE id = ?').get(id)) return { ok: false, status: 404, error: 'Pedido não encontrado' };
  db.transaction(() => {
    addEntryRow(db, id, 'nota', body, authorId);
    touch(db, id);
  })();
  return { ok: true, value: null };
}

export type TicketPatch = {
  status?: TicketStatus;
  priority?: typeof TICKET_PRIORITIES[number];
  category?: typeof TICKET_CATEGORIES[number];
  assignedTo?: number | null;
  note?: string | null;
};

export function updateTicket(db: Database.Database, id: number, patch: TicketPatch, authorId: number | null): Result<null> {
  const current = db.prepare('SELECT status, priority, category, assigned_to AS assignedTo FROM support_tickets WHERE id = ?')
    .get(id) as { status: TicketStatus; priority: string; category: string; assignedTo: number | null } | undefined;
  if (!current) return { ok: false, status: 404, error: 'Pedido não encontrado' };
  const next = patch.status ?? current.status;
  const changesStatus = next !== current.status;
  if (changesStatus && NEEDS_NOTE.has(next) && !patch.note?.trim()) {
    return { ok: false, status: 400, error: 'Escreva o que se fez antes de dar o pedido por resolvido ou fechado' };
  }
  if (patch.assignedTo && !exists(db, 'users', patch.assignedTo)) return { ok: false, status: 400, error: 'Técnico inexistente' };

  db.transaction(() => {
    const now = sqlNow();
    // Reabrir apaga as datas de fim; resolver e fechar guardam a primeira vez.
    const reopened = !NEEDS_NOTE.has(next);
    db.prepare(`UPDATE support_tickets SET status = ?, priority = ?, category = ?, assigned_to = ?,
        resolved_at = CASE WHEN ? THEN NULL WHEN ? = 'resolvido' OR ? = 'fechado' THEN COALESCE(resolved_at, ?) ELSE resolved_at END,
        closed_at = CASE WHEN ? THEN NULL WHEN ? = 'fechado' THEN COALESCE(closed_at, ?) ELSE closed_at END,
        updated_at = ? WHERE id = ?`)
      .run(next, patch.priority ?? current.priority, patch.category ?? current.category,
        patch.assignedTo === undefined ? current.assignedTo : patch.assignedTo,
        reopened ? 1 : 0, next, next, now, reopened ? 1 : 0, next, now, now, id);
    if (changesStatus) addEntryRow(db, id, 'mudanca_estado', `${STATUS_LABEL[current.status]} → ${STATUS_LABEL[next]}`, authorId);
    if (patch.note?.trim()) addEntryRow(db, id, 'nota', patch.note.trim(), authorId);
    touch(db, id);
  })();
  return { ok: true, value: null };
}

export function createTicketWorkOrder(
  db: Database.Database, id: number, input: { title?: string; assignedTo?: string | null; scheduledAt?: string | null }, authorId: number | null
): Result<number> {
  const ticket = db.prepare('SELECT subject, service_id AS serviceId, priority FROM support_tickets WHERE id = ?')
    .get(id) as { subject: string; serviceId: number | null; priority: 'baixa' | 'media' | 'alta' } | undefined;
  if (!ticket) return { ok: false, status: 404, error: 'Pedido não encontrado' };
  const workOrderId = db.transaction(() => {
    const created = createWorkOrder(db, {
      ticketId: id,
      serviceId: ticket.serviceId,
      title: input.title?.trim() || ticket.subject,
      description: `Pedido de assistência nº ${id}`,
      priority: ticket.priority,
      eventType: 'manutencao',
      assignedTo: input.assignedTo ?? null,
      scheduledAt: input.scheduledAt ?? null,
      status: input.scheduledAt ? 'agendada' : 'aguarda'
    });
    addEntryRow(db, id, 'os_criada', `OS nº ${created} criada`, authorId);
    touch(db, id);
    return created;
  })();
  return { ok: true, value: workOrderId };
}
