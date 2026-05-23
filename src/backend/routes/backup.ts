import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import {
  createBackup,
  listBackups,
  pruneBackups,
  resolveBackupDir,
  restoreBackup,
  validateBackup,
} from '../lib/backup';
import { recordAudit } from '../lib/audit';
import { requireRole } from './auth';

const restoreSchema = z.object({ file: z.string().trim().min(1) });
const importSchema = z.object({ path: z.string().trim().min(1) });

function importedStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

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

  app.post('/api/backups/import', adminOnly, async (request, reply) => {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Pedido inválido' });
    }
    const src = path.resolve(parsed.data.path);
    if (!existsSync(src)) {
      return reply.status(400).send({ error: 'Ficheiro não encontrado' });
    }
    if (!statSync(src).isFile()) {
      return reply.status(400).send({ error: 'Caminho não aponta para um ficheiro' });
    }
    const check = validateBackup(src);
    if (!check.ok) {
      return reply.status(400).send({ error: `Backup inválido: ${check.reason}` });
    }

    // Copia para o backupDir como 'imported-*' para que fique na lista e siga
    // a retenção habitual; depois restaura a partir da cópia (não toca no original).
    const imported = `imported-${importedStamp()}.sqlite`;
    const dest = path.join(resolveBackupDir(), imported);
    try {
      copyFileSync(src, dest);
    } catch (e) {
      return reply.status(500).send({ error: `Falha ao copiar para a pasta de backups: ${(e as Error).message}` });
    }

    recordAudit(request, {
      action: 'restore',
      entityType: 'backup',
      entityId: imported,
      summary: `Importou e restaurou backup ${imported}`,
      metadata: { sourcePath: src }
    });

    try {
      const result = await restoreBackup(dest);
      return { ...result, importedFile: imported };
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
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
