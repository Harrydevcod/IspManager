import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { confirmReceiptProposal, listReceiptProposals, rejectReceiptProposal } from '../lib/companion-events';
import { requireRole } from './auth';

type RequestUser = { user?: { id?: number; username?: string } };

function actor(request: unknown) {
  const user = (request as RequestUser).user;
  return { id: user?.id ?? null, username: user?.username ?? 'desconhecido' };
}

/**
 * O que chega da app móvel e precisa do desktop: recebimentos em mão por
 * confirmar e anexos das OS concluídas no terreno.
 */
export async function registerCompanionRoutes(app: FastifyInstance) {
  const billing = { preHandler: requireRole(['admin', 'operator']) };
  const field = { preHandler: requireRole(['admin', 'operator', 'technician']) };

  app.get('/api/companion/receipt-proposals', billing, async () => listReceiptProposals(getSqliteDatabase()));

  app.post('/api/companion/receipt-proposals/:id/confirm', billing, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ accountId: z.number().int().positive().nullable().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Conta invalida' });
    const result = confirmReceiptProposal(getSqliteDatabase(), id, actor(request), body.data.accountId);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    recordAudit(request, { action: 'receipt_proposal.confirmed', entityType: 'companion_event', entityId: id, summary: 'Recebimento do terreno confirmado' });
    return { ok: true };
  });

  app.post('/api/companion/receipt-proposals/:id/reject', billing, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ reason: z.string().trim().max(300).nullable().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Motivo invalido' });
    const result = rejectReceiptProposal(getSqliteDatabase(), id, actor(request), body.data.reason || null);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    recordAudit(request, { action: 'receipt_proposal.rejected', entityType: 'companion_event', entityId: id, summary: body.data.reason || null });
    return { ok: true };
  });

  app.get('/api/work-orders/:id/attachments', field, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'OS invalida' });
    return getSqliteDatabase().prepare(`
      SELECT id, kind, lat, lon, taken_at AS takenAt FROM work_order_attachments WHERE work_order_id = ? ORDER BY id
    `).all(id);
  });

  app.get('/api/work-orders/:id/attachments/:attachmentId', field, async (request, reply) => {
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    const row = getSqliteDatabase().prepare(`
      SELECT mime, data FROM work_order_attachments WHERE id = ? AND work_order_id = ? AND kind = 'photo'
    `).get(Number(attachmentId), Number(id)) as { mime: string; data: Buffer } | undefined;
    if (!row) return reply.status(404).send({ error: 'Foto inexistente' });
    return reply.header('content-type', row.mime).header('cache-control', 'private, max-age=86400').send(row.data);
  });

}
