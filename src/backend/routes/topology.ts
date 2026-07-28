import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { loadBackboneBranch, loadTopologySnapshot } from '../lib/topology-read-model';
import { searchTopology } from '../lib/topology-search';
import { requireAuth } from './auth';

const backboneParamsSchema = z.object({
  id: z.coerce.number().int().positive()
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  administrativeState: z.enum(['active', 'inactive']).optional(),
  attention: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  island: z.string().trim().min(1).max(120).optional(),
  zone: z.string().trim().min(1).max(120).optional()
}).strict();

export async function registerTopologyRoutes(app: FastifyInstance) {
  const readOnly = { preHandler: requireAuth() };

  app.get('/api/topology', readOnly, async () => {
    return loadTopologySnapshot(getSqliteDatabase());
  });

  app.get('/api/topology/backbones/:id/clients', readOnly, async (request, reply) => {
    const parsed = backboneParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Backbone invalido' });
    }
    const result = loadBackboneBranch(getSqliteDatabase(), parsed.data.id);
    if (!result) {
      return reply.status(404).send({ error: 'Backbone nao encontrado' });
    }
    return result;
  });

  app.get('/api/topology/search', readOnly, async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Parametros de pesquisa invalidos' });
    }
    return searchTopology(getSqliteDatabase(), {
      query: parsed.data.q,
      limit: parsed.data.limit,
      administrativeState: parsed.data.administrativeState,
      attention: parsed.data.attention,
      island: parsed.data.island,
      zone: parsed.data.zone
    });
  });
}
