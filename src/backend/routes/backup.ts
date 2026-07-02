import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import {
  createBackup,
  listBackups,
  pruneBackups,
  readBackupIntervalHours,
  readConfiguredBackupDir,
  resolveBackupDir,
  restoreBackup,
  validateBackup,
  validateBackupDir,
} from '../lib/backup';
import { getSqliteDatabase } from '../db/database';
import { isSetupComplete } from '../lib/auth';
import { recordAudit } from '../lib/audit';
import { requireRole } from './auth';

const restoreSchema = z.object({ file: z.string().trim().min(1) });
const importSchema = z.object({ path: z.string().trim().min(1) });
const configSchema = z.object({
  backupDir: z.string().trim().max(500).optional().default(''),
  intervalHours: z.coerce.number().int().min(0).max(168).optional().default(0)
});

function importedStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  // Sufixo de ms: dois imports no mesmo segundo não podem partilhar o nome do
  // ficheiro (o segundo copyFileSync sobrescreveria o primeiro a meio do restauro).
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export async function registerBackupRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };

  app.get('/api/backups', adminOnly, async () => {
    return {
      backupDir: resolveBackupDir(),
      configuredBackupDir: readConfiguredBackupDir(),
      intervalHours: readBackupIntervalHours(),
      entries: listBackups()
    };
  });

  // Configuração de backups: pasta de destino (ex.: pasta sincronizada
  // Drive/Dropbox/OneDrive = backup externo) e intervalo do backup automático.
  app.put('/api/backups/config', adminOnly, async (request, reply) => {
    const parsed = configSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Configuração inválida' });
    }
    const backupDir = parsed.data.backupDir.trim();
    const dirError = validateBackupDir(backupDir);
    if (dirError) {
      return reply.status(400).send({ error: dirError });
    }

    const db = getSqliteDatabase();
    const save = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    db.transaction(() => {
      save.run('backupDir', backupDir);
      save.run('backupIntervalHours', String(parsed.data.intervalHours));
    })();

    recordAudit(request, {
      action: 'update',
      entityType: 'backup',
      summary: 'Atualizou configuração de backups',
      metadata: { backupDir: backupDir || '(default)', intervalHours: parsed.data.intervalHours }
    });
    return { backupDir: resolveBackupDir(), intervalHours: parsed.data.intervalHours };
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

  // Handler partilhado: valida o ficheiro indicado, copia-o para o backupDir
  // como 'imported-*' (fica na lista e segue a retenção habitual) e restaura a
  // partir da cópia (não toca no original). Usado pelo import autenticado e
  // pelo import de primeiro arranque.
  async function handleImport(request: FastifyRequest, reply: FastifyReply, audited: boolean) {
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

    const imported = `imported-${importedStamp()}.sqlite`;
    const dest = path.join(resolveBackupDir(), imported);
    try {
      copyFileSync(src, dest);
    } catch (e) {
      return reply.status(500).send({ error: `Falha ao copiar para a pasta de backups: ${(e as Error).message}` });
    }

    // No primeiro arranque não há utilizador para atribuir o audit — e a linha
    // seria substituída pelo restore de qualquer forma.
    if (audited) {
      recordAudit(request, {
        action: 'restore',
        entityType: 'backup',
        entityId: imported,
        summary: `Importou e restaurou backup ${imported}`,
        metadata: { sourcePath: src }
      });
    }

    try {
      const result = await restoreBackup(dest);
      return { ...result, importedFile: imported };
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
  }

  app.post('/api/backups/import', adminOnly, async (request, reply) => {
    return handleImport(request, reply, true);
  });

  // Primeiro arranque (BD sem utilizadores): permite restaurar um backup antes
  // de existir qualquer conta — a alternativa a criar o admin do zero. Fecha-se
  // sozinho: assim que o restore traz utilizadores, isSetupComplete() passa a
  // true e a rota devolve 409 para sempre.
  app.post('/api/backups/setup-import', async (request, reply) => {
    if (isSetupComplete()) {
      return reply.status(409).send({ error: 'Setup ja foi concluido' });
    }
    // Sem utilizador para o audit (e a linha morreria no swap da BD) — o log do
    // processo é o único rasto durável de que a BD foi substituída no 1.º arranque.
    request.log.warn({ body: request.body }, 'setup-import: restauro de BD no primeiro arranque');
    return handleImport(request, reply, false);
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
