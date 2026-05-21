import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  entityType: z.string().trim().optional(),
  actorUserId: z.coerce.number().int().positive().optional()
});

export async function registerAuditRoutes(app: FastifyInstance) {
  app.get('/api/audit-logs', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Filtros invalidos' });
    }

    const where: string[] = [];
    const params: Record<string, unknown> = { limit: parsed.data.limit };
    if (parsed.data.entityType) {
      where.push('entity_type = @entityType');
      params.entityType = parsed.data.entityType;
    }
    if (parsed.data.actorUserId) {
      where.push('actor_user_id = @actorUserId');
      params.actorUserId = parsed.data.actorUserId;
    }

    const rows = getSqliteDatabase().prepare(`
      SELECT
        id,
        actor_user_id AS actorUserId,
        actor_username AS actorUsername,
        actor_role AS actorRole,
        action,
        entity_type AS entityType,
        entity_id AS entityId,
        summary,
        metadata_json AS metadataJson,
        created_at AS createdAt
      FROM audit_logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT @limit
    `).all(params);

    return rows;
  });
}
