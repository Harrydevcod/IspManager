import type { FastifyInstance } from 'fastify';
import { getSqliteDatabase } from '../db/database';
import { issueCustomerPortal, revokeCustomerPortal } from '../lib/customer-portal-publish';
import { readSecret } from '../lib/secrets';
import { recordAudit } from '../lib/audit';
import { requireRole } from './auth';

export async function registerCustomerPortalRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireRole(['admin']) };
  const configuration = () => {
    const db = getSqliteDatabase();
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'smsRelayUrl'").get() as { value: string } | undefined;
    return { db, url: row?.value || '', key: readSecret(db, 'smsRelayAdminKey') };
  };
  app.get('/api/clients/:id/portal-links', guard, async (request, reply) => {
    const clientId = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(clientId) || clientId <= 0) return reply.code(400).send({ error: 'Cliente inválido' });
    reply.header('Cache-Control', 'no-store');
    return getSqliteDatabase().prepare('SELECT id, expires_at AS expiresAt, published_at AS publishedAt, revoked_at AS revokedAt, created_at AS createdAt FROM customer_portal_links WHERE client_id = ? ORDER BY created_at DESC LIMIT 100').all(clientId);
  });
  app.post('/api/clients/:id/portal-links', guard, async (request, reply) => {
    const clientId = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(clientId) || clientId <= 0) return reply.code(400).send({ error: 'Cliente inválido' });
    const { db, url, key } = configuration();
    if (!url || !key) return reply.code(409).send({ error: 'Configure o relé antes de criar o link.' });
    try {
      const result = await issueCustomerPortal(db, clientId, url, key);
      recordAudit(request, { action: 'customer_portal.issue', entityType: 'client', entityId: clientId });
      reply.header('Cache-Control', 'no-store');
      return reply.code(201).send(result);
    } catch {
      return reply.code(502).send({ error: 'Não foi possível criar a página. Verifique o cliente e o relé.' });
    }
  });
  app.delete('/api/clients/:id/portal-links/:linkId', guard, async (request, reply) => {
    const { id, linkId } = request.params as { id: string; linkId: string };
    const clientId = Number(id);
    if (!Number.isSafeInteger(clientId) || clientId <= 0 || !/^[a-f0-9]{64}$/.test(linkId)) return reply.code(400).send({ error: 'Pedido inválido' });
    const { db, url, key } = configuration();
    if (!db.prepare('SELECT 1 FROM customer_portal_links WHERE id = ? AND client_id = ?').get(linkId, clientId)) return reply.code(404).send({ error: 'Link não encontrado' });
    if (!url || !key) return reply.code(409).send({ error: 'Configure o relé antes de revogar o link.' });
    try {
      await revokeCustomerPortal(db, linkId, url, key);
      recordAudit(request, { action: 'customer_portal.revoke', entityType: 'client', entityId: clientId });
      return reply.code(204).send();
    } catch { return reply.code(502).send({ error: 'Não foi possível revogar o link no relé.' }); }
  });
}
