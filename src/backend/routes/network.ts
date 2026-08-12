import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { loadNetworkStatus, loadProbeEvents, readProbeConfig, runNetworkProbe } from '../lib/network-probe';
import { runJob } from '../lib/jobRuns';
import { requireAuth } from './auth';

const statusQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30)
}).strict();

const eventsParamsSchema = z.object({
  kind: z.enum(['backbone', 'assignment']),
  id: z.coerce.number().int().positive()
});

const eventsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30)
}).strict();

export async function registerNetworkRoutes(app: FastifyInstance) {
  const readOnly = { preHandler: requireAuth() };

  app.get('/api/network/status', readOnly, async (request, reply) => {
    const parsed = statusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }
    return loadNetworkStatus(getSqliteDatabase(), parsed.data.days);
  });

  app.get('/api/network/targets/:kind/:id/events', readOnly, async (request, reply) => {
    const params = eventsParamsSchema.safeParse(request.params);
    const query = eventsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }
    const windowStart = new Date(Date.now() - query.data.days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const events = loadProbeEvents(getSqliteDatabase(), windowStart, { kind: params.data.kind, id: params.data.id });
    return { events, windowDays: query.data.days };
  });

  // "Testar agora": sonda sem esperar pelo intervalo. Corre mesmo com a sonda
  // periódica desligada — é o botão que serve para experimentar antes de ligar.
  app.post('/api/network/probe', readOnly, async () => {
    const db = getSqliteDatabase();
    const config = readProbeConfig(db);
    return runJob('network_probe_manual', () => runNetworkProbe(db, {
      includeClients: config.includeClients,
      failThreshold: config.failThreshold
    }));
  });
}
