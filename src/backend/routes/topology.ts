import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { loadBackboneBranch, loadTopologySnapshot } from '../lib/topology-read-model';
import { searchTopology } from '../lib/topology-search';
import { requireAuth, requireRole } from './auth';
import { recordAuditStrict } from '../lib/audit';
import { readRouterConfig } from '../lib/routeros';
import { readRouterLive } from '../lib/router-live';
import { readTopologyLive } from '../lib/topology-live';
import type { TopologyLive, TopologyPosition } from '../../shared/topology';

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

const directionSchema = z.enum(['TB', 'LR']);
// O id do nó no grafo (`backbone:3`, `root:isp`, `client:5@9`…): texto curto e sem espaços.
const nodeKeySchema = z.string().regex(/^[a-z-]+:[\w:@.-]{1,100}$/);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);

const positionsWriteSchema = z.object({
  direction: directionSchema,
  // `x`/`y` a null devolve o nó ao desenho automático (é assim que o desfazer apaga).
  positions: z.array(z.object({
    nodeKey: nodeKeySchema,
    x: coordinate.nullable(),
    y: coordinate.nullable()
  }).strict().refine((item) => (item.x === null) === (item.y === null))).min(1).max(1000)
}).strict();

export async function registerTopologyRoutes(app: FastifyInstance) {
  const readOnly = { preHandler: requireAuth() };
  let liveCache: { db: object; key: string; at: number; value: TopologyLive } | null = null;
  let livePending: { db: object; key: string; promise: Promise<TopologyLive> } | null = null;

  app.get('/api/topology/live', readOnly, async (): Promise<TopologyLive> => {
    const db = getSqliteDatabase();
    const config = readRouterConfig(db);
    const host = config.host;
    const revision = (db.prepare('SELECT total_changes() AS revision').get() as { revision: number }).revision;
    const key = `${host}:${config.enabled}:${revision}`;
    const backbones = loadTopologySnapshot(db).backbones;
    const routerDeviceId = backbones.find((node) => node.ipAddress === host && host)?.backboneDeviceId ?? null;
    if (liveCache?.db === db && liveCache.key === key && Date.now() - liveCache.at < 5_000) return liveCache.value;
    if (livePending?.db === db && livePending.key === key) return livePending.promise;
    const promise = (async (): Promise<TopologyLive> => {
      const result = await readRouterLive(db, (transport, config) => readTopologyLive(transport, config, backbones, routerDeviceId));
      const value: TopologyLive = result.available
        ? { available: true, routerDeviceId, interfaces: result.interfaces, seen: result.seen, checks: result.checks }
        : { available: false, routerDeviceId, reason: result.reason };
      if (value.available) liveCache = { db, key, at: Date.now(), value };
      return value;
    })();
    livePending = { db, key, promise };
    try { return await promise; } finally { if (livePending?.promise === promise) livePending = null; }
  });

  const canManage = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/topology/positions', readOnly, async (request, reply) => {
    const direction = directionSchema.safeParse((request.query as { direction?: unknown }).direction);
    if (!direction.success) return reply.status(400).send({ error: 'Direcao invalida' });
    const rows = getSqliteDatabase().prepare(
      'SELECT node_key AS nodeKey, x, y FROM topology_positions WHERE direction = ?'
    ).all(direction.data) as TopologyPosition[];
    return { direction: direction.data, positions: rows };
  });

  // ponytail: arrumar o mapa é cosmético — não vai à auditoria a cada arrasto, só o
  // "Reorganizar", que apaga tudo de uma vez.
  app.put('/api/topology/positions', canManage, async (request, reply) => {
    const parsed = positionsWriteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Posicoes invalidas' });
    const db = getSqliteDatabase();
    const upsert = db.prepare(`
      INSERT INTO topology_positions (direction, node_key, x, y, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (direction, node_key) DO UPDATE SET
        x = excluded.x, y = excluded.y, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `);
    const remove = db.prepare('DELETE FROM topology_positions WHERE direction = ? AND node_key = ?');
    const { direction, positions } = parsed.data;
    db.transaction(() => {
      for (const item of positions) {
        if (item.x === null || item.y === null) remove.run(direction, item.nodeKey);
        else upsert.run(direction, item.nodeKey, item.x, item.y, request.user?.id ?? null);
      }
    })();
    return { saved: positions.length };
  });

  app.delete('/api/topology/positions', canManage, async (request, reply) => {
    const direction = directionSchema.safeParse((request.query as { direction?: unknown }).direction);
    if (!direction.success) return reply.status(400).send({ error: 'Direcao invalida' });
    const db = getSqliteDatabase();
    const removed = db.transaction(() => {
      const result = db.prepare('DELETE FROM topology_positions WHERE direction = ?').run(direction.data);
      recordAuditStrict(db, request, {
        action: 'topology.layout.reset',
        entityType: 'topology_layout',
        summary: `Reorganizou o mapa (${direction.data}): ${result.changes} ${result.changes === 1 ? 'posicao apagada' : 'posicoes apagadas'}`,
        metadata: { direction: direction.data, removed: result.changes }
      });
      return result.changes;
    })();
    return { removed };
  });

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
