import { networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { authBypassed } from '../lib/auth';
import { getLocalProtection } from '../lib/local-protection';
import { preparePairedMobileGateway } from '../lib/mobile-device-controller';
import { isMobileListenAddress, MobileGatewayLifecycle } from '../lib/mobile-gateway-lifecycle';
import { confirmSessionPassword, requireRole } from './auth';

const startSchema = z.object({host: z.string().max(45), port: z.number().int().min(1).max(65535), confirmPassword: z.string().min(1).max(200)}).strict();

/** Local desktop controls; the mobile gateway blocks this entire route family. */
export async function registerMobileAccessRoutes(app: FastifyInstance) {
  const adminOnly = {preHandler: requireRole(['admin'])};
  const lifecycle = new MobileGatewayLifecycle({
    allowedAddress: isMobileListenAddress,
    prepare: () => preparePairedMobileGateway(app, getSqliteDatabase(), getLocalProtection())
  });
  app.addHook('onClose', async () => { await lifecycle.stop(); });

  app.get('/api/mobile-access', adminOnly, async () => ({
    ...lifecycle.status(),
    addresses: Object.values(networkInterfaces()).flatMap(entries => entries ?? []).filter(entry => isMobileListenAddress(entry.address)).map(entry => entry.address)
  }));

  app.post('/api/mobile-access/start', adminOnly, async (request, reply) => {
    if (authBypassed()) return reply.status(503).send({error: 'Autenticação obrigatória para acesso móvel.'});
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success || !isMobileListenAddress(parsed.data.host)) return reply.status(400).send({error: 'Escolha um endereço de rede local válido.'});
    if (!await confirmSessionPassword(request, reply, parsed.data.confirmPassword)) return reply;
    try {
      const address = await lifecycle.start(parsed.data.host, parsed.data.port);
      recordAudit(request, {action:'mobile_access_started', entityType:'mobile_access', metadata:address});
      return {running:true, ...address};
    } catch (error) {
      const message = error instanceof Error && error.message === 'MOBILE_DESKTOP_IDENTITY_CONFLICT'
        ? 'A identidade do computador mudou. Volte a parear o telemóvel antes de ativar o acesso móvel.'
        : 'Não foi possível ativar o acesso móvel. Verifique o pareamento e a rede.';
      return reply.status(409).send({error: message});
    }
  });

  app.post('/api/mobile-access/stop', adminOnly, async (request) => {
    await lifecycle.stop();
    recordAudit(request, {action:'mobile_access_stopped', entityType:'mobile_access'});
    return lifecycle.status();
  });
  return lifecycle;
}
