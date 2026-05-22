import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
  entityType: z.string().trim().optional(),
  actorUserId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function registerAuditRoutes(app: FastifyInstance) {
  app.get('/api/audit-logs', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Filtros invalidos' });
    }

    const { page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: pageSize, offset };
    if (parsed.data.entityType) {
      where.push('entity_type = @entityType');
      params.entityType = parsed.data.entityType;
    }
    if (parsed.data.actorUserId) {
      where.push('actor_user_id = @actorUserId');
      params.actorUserId = parsed.data.actorUserId;
    }
    if (parsed.data.dateFrom) {
      where.push('created_at >= @dateFrom');
      params.dateFrom = `${parsed.data.dateFrom} 00:00:00`;
    }
    if (parsed.data.dateTo) {
      where.push('created_at <= @dateTo');
      params.dateTo = `${parsed.data.dateTo} 23:59:59`;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

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
      ${whereSql}
      ORDER BY id DESC
      LIMIT @limit
      OFFSET @offset
    `).all(params);

    const total = getSqliteDatabase().prepare(`
      SELECT COUNT(*) AS total
      FROM audit_logs
      ${whereSql}
    `).get(params) as { total: number };

    const entities = getSqliteDatabase().prepare(`
      SELECT DISTINCT entity_type AS entityType
      FROM audit_logs
      ORDER BY entity_type ASC
    `).all() as { entityType: string }[];

    return {
      rows,
      page,
      pageSize,
      total: total.total,
      totalPages: Math.max(1, Math.ceil(total.total / pageSize)),
      entities: entities.map((row) => row.entityType)
    };
  });
}
