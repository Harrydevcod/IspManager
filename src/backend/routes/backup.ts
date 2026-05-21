import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import {
  createBackup,
  listBackups,
  pruneBackups,
  resolveBackupDir,
  restoreBackup,
} from '../lib/backup';
import { recordAudit } from '../lib/audit';
import { requireRole } from './auth';

const restoreSchema = z.object({ file: z.string().trim().min(1) });

export async function registerBackupRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };

  app.get('/api/backups', adminOnly, async () => {
    return { backupDir: resolveBackupDir(), entries: listBackups() };
  });

  app.post('/api/backups', adminOnly, async (request) => {
    const entry = await createBackup('manual');
    pruneBackups();
    recordAudit(request, {
      action: 'create',
      entityType: 'backup',
      entityId: entry.file,
      summary: `Criou backup ${entry.file}`,
      metadata: { sizeBytes: entry.sizeBytes }
    });
    return entry;
  });

  app.post('/api/backups/restore', adminOnly, async (request, reply) => {
    const parsed = restoreSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Pedido inválido' });
    }
    const name = parsed.data.file;
    // Only a bare filename inside the backup dir is allowed (no traversal).
    if (name !== path.basename(name)) {
      return reply.status(400).send({ error: 'Nome de ficheiro inválido' });
    }
    const full = path.join(resolveBackupDir(), name);
    try {
      recordAudit(request, {
        action: 'restore',
        entityType: 'backup',
        entityId: name,
        summary: `Restaurou backup ${name}`
      });
      const result = await restoreBackup(full);
      return result;
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
  });
}
