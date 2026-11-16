import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { MAINTENANCE_KINDS, previewMaintenanceNotice, sendMaintenanceNotice } from '../lib/maintenance-notices';
import { businessDay } from '../../shared/business-day';
import { requireRole } from './auth';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const schema = z.object({
  kind: z.enum(MAINTENANCE_KINDS),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: time,
  end: time,
  dryRun: z.boolean().optional().default(false)
}).refine((value) => value.end > value.start, { message: 'O fim tem de ser depois do início' });

/** Avisar os clientes a jusante de uma torre ou ramo de uma manutenção marcada. */
export async function registerMaintenanceNoticeRoutes(app: FastifyInstance) {
  app.post('/api/backbone/:id/maintenance-notice', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const deviceId = Number((request.params as { id: string }).id);
    const parsed = schema.safeParse(request.body);
    if (!Number.isInteger(deviceId) || deviceId <= 0 || !parsed.success) return reply.status(400).send({ error: 'Aviso de manutenção inválido' });
    if (parsed.data.day < businessDay()) return reply.status(400).send({ error: 'A data já passou' });
    const db = getSqliteDatabase();
    if (!db.prepare("SELECT 1 FROM backbone_devices WHERE id = ? AND status <> 'retired'").get(deviceId)) return reply.status(404).send({ error: 'Equipamento não encontrado' });
    if (parsed.data.dryRun) return previewMaintenanceNotice(db, deviceId);
    const { dryRun: _dryRun, ...window } = parsed.data;
    const result = sendMaintenanceNotice(db, deviceId, window, request.user?.id ?? null);
    recordAudit(request, { action: 'maintenance_notice.send', entityType: 'backbone_device', entityId: deviceId });
    return result;
  });
}
