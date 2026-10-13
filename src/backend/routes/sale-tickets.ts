import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAuditStrict } from '../lib/audit';
import { cancelSaleTicket, createSaleTicket, loadSaleTicket, saleTicketSchema } from '../lib/sale-tickets';
import { confirmSessionPassword, requireRole } from './auth';

const cancellationSchema = z.object({
  reason: z.string().trim().min(10).max(500),
  productsReturned: z.literal(true),
  confirmPassword: z.string().min(1).max(200)
}).strict();

export async function registerSaleTicketRoutes(app: FastifyInstance) {
  const billingWrite = { preHandler: requireRole(['admin', 'operator']) };

  app.post('/api/payments/sale-tickets', billingWrite, async (request, reply) => {
    const parsed = saleTicketSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Dados do talão inválidos: ' + parsed.error.issues[0].message });
    const db = getSqliteDatabase();
    const result = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM payments WHERE sale_request_key=?').get(parsed.data.requestKey);
      const issued = createSaleTicket(db, parsed.data, request.user?.id ?? null);
      if (issued.ok && !existing) {
        const ticket = loadSaleTicket(db, issued.value.paymentId)!;
        recordAuditStrict(db, request, {
          action: 'create', entityType: 'payment', entityId: ticket.paymentId,
          summary: `Emitiu e recebeu o talão ${ticket.documentNumber}`,
          metadata: { ...ticket, documentType: 'sale_ticket' }
        });
      }
      return issued;
    }).immediate();
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    return reply.status(201).send({ ...result.value, documentType: 'sale_ticket', status: loadSaleTicket(db, result.value.paymentId)!.status });
  });

  app.get('/api/payments/:id/sale-ticket', billingWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.status(400).send({ error: 'Talão de venda inválido' });
    const ticket = loadSaleTicket(getSqliteDatabase(), id);
    if (!ticket) return reply.status(404).send({ error: 'Talão de Venda não encontrado.' });
    return { ...ticket, documentType: 'sale_ticket' };
  });

  app.post('/api/payments/:id/sale-ticket/cancel', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = cancellationSchema.safeParse(request.body);
    if (!Number.isSafeInteger(id) || id <= 0 || !parsed.success) return reply.status(400).send({ error: 'A anulação exige motivo, password e confirmação da devolução dos produtos.' });
    if (!(await confirmSessionPassword(request, reply, parsed.data.confirmPassword))) return reply;
    const db = getSqliteDatabase();
    const result = db.transaction(() => {
      const original = loadSaleTicket(db, id);
      const cancelled = cancelSaleTicket(db, id, parsed.data.reason, parsed.data.productsReturned, request.user?.id ?? null);
      if (cancelled.ok && original?.status !== 'cancelled') {
        recordAuditStrict(db, request, {
          action: 'cancel', entityType: 'payment', entityId: id,
          summary: `Anulou o talão ${cancelled.value.documentNumber}`,
          metadata: { ...original, documentType: 'sale_ticket', reason: parsed.data.reason, productsReturned: true }
        });
      }
      return cancelled;
    }).immediate();
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    return { ...result.value, documentType: 'sale_ticket', status: 'cancelled' };
  });
}
