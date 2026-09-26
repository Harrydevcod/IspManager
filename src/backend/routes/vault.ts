import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Vault } from '../lib/vault';
import { setNormalBackupsBlocked } from '../lib/backup';
import { getSqliteDatabase } from '../db/database';
import { getLocalProtection } from '../lib/local-protection';
import { migrateCredentials } from '../lib/vault-migration';
import { setCredentialVault } from '../lib/secrets';
import { confirmSessionPassword, requireRole } from './auth';

const keyBody = z.object({ recoveryKey: z.string().min(1).max(160) });
const passwordBody = z.object({ password: z.string().min(1).max(200) });
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;

/** Routes keep the recovery material out of logs, audit metadata and caches. */
export async function registerVaultRoutes(app: FastifyInstance, vault: Vault | null, migrationError: string | null = null) {
  let administrativeError = migrationError;
  const failures = new Map<string, { count: number; until: number }>();
  const options = { preHandler: requireRole(['admin']), onRequest: async (_request: FastifyRequest, reply: { header(name: string, value: string): unknown }) => { reply.header('Cache-Control', 'no-store'); }, logLevel: 'silent' as const };
  const identity = (request: FastifyRequest) => `${request.user?.id ?? 'local'}:${request.ip}`;
  const limited = (request: FastifyRequest) => {
    const entry = failures.get(identity(request));
    return !!entry && entry.until > Date.now() && entry.count >= MAX_FAILURES;
  };
  const fail = (request: FastifyRequest) => {
    const id = identity(request);
    const prev = failures.get(id);
    const count = prev && prev.until > Date.now() ? prev.count + 1 : 1;
    failures.set(id, { count, until: Date.now() + WINDOW_MS });
  };
  const clear = (request: FastifyRequest) => failures.delete(identity(request));
  const common = (reply: { header(name: string, value: string): unknown }) => reply.header('Cache-Control', 'no-store');

  app.get('/api/vault/status', options, async (_request, reply) => {
    common(reply);
    return { status: vault?.status() ?? 'absent', ...(administrativeError ? { migrationError: administrativeError } : {}) };
  });

  app.post('/api/vault/recovery-key', options, async (request, reply) => {
    common(reply);
    if (vault?.status() !== 'recovery_pending') return reply.status(409).send({ error: 'Chave indisponível.' });
    const parsed = passwordBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Pedido inválido.' });
    if (!await confirmSessionPassword(request, reply, parsed.data.password)) return;
    try { return { recoveryKey: vault.pendingRecoveryKey() }; }
    catch { return reply.status(409).send({ error: 'Chave indisponível.' }); }
  });

  app.post('/api/vault/confirm', options, async (request, reply) => {
    common(reply);
    if (limited(request)) return reply.status(429).send({ error: 'Demasiadas tentativas. Tente mais tarde.' });
    if (vault?.status() !== 'recovery_pending') return reply.status(409).send({ error: 'Confirmação indisponível.' });
    const parsed = keyBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Pedido inválido.' });
    try { vault.confirmRecovery(parsed.data.recoveryKey); clear(request); return { status: vault.status() }; }
    catch { fail(request); return reply.status(400).send({ error: 'Chave incorreta.' }); }
  });

  app.post('/api/vault/unlock', options, async (request, reply) => {
    common(reply);
    if (limited(request)) return reply.status(429).send({ error: 'Demasiadas tentativas. Tente mais tarde.' });
    if (vault?.status() !== 'locked') return reply.status(409).send({ error: 'Desbloqueio indisponível.' });
    const parsed = keyBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Pedido inválido.' });
    try { vault.unlock(parsed.data.recoveryKey); }
    catch { fail(request); return reply.status(400).send({ error: 'Chave incorreta.' }); }
    clear(request);
    try {
      const migration = migrateCredentials(getSqliteDatabase(), vault, getLocalProtection());
      if (!migration.ok) administrativeError = `${migration.field}: ${migration.reason}`;
    } catch { administrativeError = 'VAULT_MIGRATION_FAILED'; }
    if (administrativeError) {
      setCredentialVault(null);
      setNormalBackupsBlocked(true);
      return { status: vault.status(), migrationError: administrativeError };
    }
    setNormalBackupsBlocked(false);
    return { status: vault.status() };
  });
}
