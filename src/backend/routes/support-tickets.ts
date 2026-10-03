import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import {
  addTicketNote, createTicketWorkOrder, getTicket, listTickets, openTicket, updateTicket,
  TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES
} from '../lib/support-tickets';
import { requireAuth, requireRole } from './auth';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const note = z.string().trim().min(1, 'Escreva a nota').max(4000);

const listQuery = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  clientId: z.coerce.number().int().positive().optional()
}).strict();

const openSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  serviceId: z.coerce.number().int().positive().optional().nullable(),
  subject: z.string().trim().min(1, 'Indique o assunto').max(140),
  channel: z.enum(TICKET_CHANNELS),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assignedTo: z.coerce.number().int().positive().optional().nullable(),
  note
}).strict();

const patchSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  assignedTo: z.coerce.number().int().positive().optional().nullable(),
  note: z.string().trim().max(4000).optional().nullable()
}).strict();

const workOrderSchema = z.object({
  title: z.string().trim().max(140).optional(),
  assignedTo: z.string().trim().max(120).optional().nullable(),
  scheduledAt: z.string().trim().max(40).optional().nullable()
}).strict();

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.status(400).send({ error: error.issues[0]?.message ?? 'Dados inválidos' });
}

const authorOf = (request: FastifyRequest) => request.user?.id ?? null;

export async function registerSupportTicketRoutes(app: FastifyInstance) {
  // Os mesmos guardas das OS técnicas: qualquer sessão lê, quem trata da rede escreve.
  const canWrite = { preHandler: requireRole(['admin', 'operator', 'technician']) };

  app.get('/api/tickets', { preHandler: requireAuth() }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    return listTickets(getSqliteDatabase(), query.data);
  });

  /** Quem pode ficar com um pedido: os utilizadores ativos. */
  app.get('/api/tickets/assignees', { preHandler: requireAuth() }, async () =>
    getSqliteDatabase().prepare('SELECT id, full_name AS fullName, role FROM users WHERE active = 1 ORDER BY full_name').all());

  app.get('/api/tickets/:id', { preHandler: requireAuth() }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const ticket = params.success ? getTicket(getSqliteDatabase(), params.data.id) : null;
    if (!ticket) return reply.status(404).send({ error: 'Pedido não encontrado' });
    return ticket;
  });

  app.post('/api/tickets', canWrite, async (request, reply) => {
    const body = openSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const db = getSqliteDatabase();
    const result = openTicket(db, body.data, authorOf(request));
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    recordAudit(request, {
      action: 'create', entityType: 'support_ticket', entityId: result.value,
      summary: `Abriu o pedido de assistência nº ${result.value}`, metadata: { clientId: body.data.clientId, category: body.data.category }
    });
    return reply.status(201).send(getTicket(db, result.value));
  });

  app.patch('/api/tickets/:id', canWrite, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'Pedido não encontrado' });
    const body = patchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const db = getSqliteDatabase();
    const result = updateTicket(db, params.data.id, body.data, authorOf(request));
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    recordAudit(request, {
      action: 'update', entityType: 'support_ticket', entityId: params.data.id,
      summary: `Atualizou o pedido de assistência nº ${params.data.id}`, metadata: { status: body.data.status ?? null }
    });
    return getTicket(db, params.data.id);
  });

  app.post('/api/tickets/:id/entries', canWrite, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'Pedido não encontrado' });
    const body = z.object({ body: note }).strict().safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const db = getSqliteDatabase();
    const result = addTicketNote(db, params.data.id, body.data.body, authorOf(request));
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    return reply.status(201).send(getTicket(db, params.data.id));
  });

  app.post('/api/tickets/:id/work-orders', canWrite, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'Pedido não encontrado' });
    const body = workOrderSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const db = getSqliteDatabase();
    const result = createTicketWorkOrder(db, params.data.id, body.data, authorOf(request));
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    recordAudit(request, {
      action: 'create', entityType: 'work_order', entityId: result.value,
      summary: `Criou a OS nº ${result.value} a partir do pedido nº ${params.data.id}`, metadata: { ticketId: params.data.id }
    });
    return reply.status(201).send(getTicket(db, params.data.id));
  });
}
