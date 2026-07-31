import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAuditStrict } from '../lib/audit';
import {
  BackboneConflictError,
  BackboneNotFoundError,
  BackboneValidationError,
  clearAssignmentBackbone,
  createBackbone,
  getBackbone,
  listAssignments,
  listBackbones,
  setAssignmentBackbone,
  updateBackbone
} from '../lib/backbone-management';
import { requireAuth, requireRole } from './auth';

const idSchema = z.union([
  z.number().int().positive().safe(),
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().safe())
]);
const pageSchema = z.coerce.number().int().min(1).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(25);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => value ?? null);

const backboneParamsSchema = z.object({ id: idSchema });
const assignmentParamsSchema = z.object({ id: idSchema });
const backboneListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'maintenance', 'retired']).optional(),
  upstreamDeviceId: idSchema.optional(),
  page: pageSchema,
  pageSize: pageSizeSchema
}).strict();
const assignmentListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  mapping: z.enum(['all', 'linked', 'unlinked']).default('all'),
  backboneDeviceId: idSchema.optional(),
  page: pageSchema,
  pageSize: pageSizeSchema
}).strict();
const backboneWriteSchema = z.object({
  catalogId: idSchema,
  name: z.string().trim().min(1).max(180),
  status: z.enum(['active', 'maintenance', 'retired']),
  serialNumber: optionalText(180),
  assetTag: optionalText(180),
  ipAddress: optionalText(80),
  macAddress: optionalText(80),
  island: optionalText(120),
  zone: optionalText(120),
  notes: optionalText(2_000),
  // Lista completa das alimentações: vazia = Internet, várias = multi-WAN.
  upstreamDeviceIds: z.array(idSchema).max(16).optional().transform((value) => value ?? []),
  expectedUpdatedAt: z.string().trim().min(1).max(80).optional()
}).strict();
const assignmentBackboneSchema = z.object({
  backboneDeviceId: idSchema,
  reason: optionalText(1_000)
}).strict();
const clearAssignmentBackboneSchema = z.object({
  reason: optionalText(1_000)
}).strict();

function repositoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof BackboneValidationError) return reply.status(400).send({ error: error.message });
  if (error instanceof BackboneNotFoundError) return reply.status(404).send({ error: error.message });
  if (error instanceof BackboneConflictError) return reply.status(409).send({ error: error.message });
  throw error;
}

function activeBackboneIdForAssignment(assignmentId: number): number | null {
  const row = getSqliteDatabase().prepare(`
    SELECT backbone_device_id AS backboneDeviceId
    FROM backbone_assignment_links
    WHERE assignment_id = ? AND ended_at IS NULL
  `).get(assignmentId) as { backboneDeviceId: number } | undefined;
  return row?.backboneDeviceId ?? null;
}

function activeAssignmentExists(assignmentId: number): boolean {
  return Boolean(getSqliteDatabase().prepare(`
    SELECT 1 FROM service_device_assignments WHERE id = ? AND end_date IS NULL
  `).get(assignmentId));
}

function catalogExists(catalogId: number): boolean {
  return Boolean(getSqliteDatabase().prepare('SELECT 1 FROM equipment_catalog WHERE id = ?').get(catalogId));
}

export async function registerTopologyManagementRoutes(app: FastifyInstance) {
  const readOnly = { preHandler: requireAuth() };
  const canManage = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/topology/backbones', readOnly, async (request, reply) => {
    const parsed = backboneListSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Parametros de backbone invalidos' });
    return listBackbones(getSqliteDatabase(), parsed.data);
  });

  app.get('/api/topology/backbones/:id', readOnly, async (request, reply) => {
    const parsed = backboneParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Backbone invalido' });
    const backbone = getBackbone(getSqliteDatabase(), parsed.data.id);
    if (!backbone) return reply.status(404).send({ error: 'Backbone nao encontrado' });
    return backbone;
  });

  app.post('/api/topology/backbones', canManage, async (request, reply) => {
    const parsed = backboneWriteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Dados de backbone invalidos' });
    if (!catalogExists(parsed.data.catalogId)) return reply.status(404).send({ error: 'Catalogo nao encontrado' });
    try {
      const db = getSqliteDatabase();
      const backbone = db.transaction(() => {
        const created = createBackbone(db, parsed.data, request.user?.id ?? null);
        recordAuditStrict(db, request, {
          action: 'topology.backbone.create',
          entityType: 'backbone_device',
          entityId: created.id,
          metadata: {
            backboneDeviceId: created.id,
            catalogId: created.catalogId,
            previousStatus: null,
            nextStatus: created.status,
            previousUpstreamDeviceIds: [],
            nextUpstreamDeviceIds: created.upstreams.map((unit) => unit.id)
          }
        });
        return created;
      })();
      return reply.status(201).send(backbone);
    } catch (error) {
      return repositoryError(reply, error);
    }
  });

  app.put('/api/topology/backbones/:id', canManage, async (request, reply) => {
    const params = backboneParamsSchema.safeParse(request.params);
    const body = backboneWriteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'Dados de backbone invalidos' });
    if (!catalogExists(body.data.catalogId)) return reply.status(404).send({ error: 'Catalogo nao encontrado' });
    const previous = getBackbone(getSqliteDatabase(), params.data.id);
    if (!previous) return reply.status(404).send({ error: 'Backbone nao encontrado' });
    try {
      const db = getSqliteDatabase();
      const backbone = db.transaction(() => {
        const updated = updateBackbone(db, params.data.id, body.data, request.user?.id ?? null);
        recordAuditStrict(db, request, {
          action: 'topology.backbone.update',
          entityType: 'backbone_device',
          entityId: updated.id,
          metadata: {
            backboneDeviceId: updated.id,
            catalogId: updated.catalogId,
            previousStatus: previous.status,
            nextStatus: updated.status,
            previousUpstreamDeviceIds: previous.upstreams.map((unit) => unit.id),
            nextUpstreamDeviceIds: updated.upstreams.map((unit) => unit.id)
          }
        });
        return updated;
      })();
      return reply.send(backbone);
    } catch (error) {
      return repositoryError(reply, error);
    }
  });

  app.get('/api/topology/assignments', readOnly, async (request, reply) => {
    const parsed = assignmentListSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Parametros de atribuicao invalidos' });
    return listAssignments(getSqliteDatabase(), parsed.data);
  });

  app.put('/api/topology/assignments/:id/backbone', canManage, async (request, reply) => {
    const params = assignmentParamsSchema.safeParse(request.params);
    const body = assignmentBackboneSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'Dados de associacao invalidos' });
    if (!activeAssignmentExists(params.data.id)) return reply.status(404).send({ error: 'Atribuicao ativa nao encontrada' });
    const previousBackboneDeviceId = activeBackboneIdForAssignment(params.data.id);
    try {
      const db = getSqliteDatabase();
      const assignment = db.transaction(() => {
        const linked = setAssignmentBackbone(db, params.data.id, body.data, request.user?.id ?? null);
        if (previousBackboneDeviceId !== linked.backboneDeviceId) {
          recordAuditStrict(db, request, {
            action: previousBackboneDeviceId === null ? 'topology.assignment.link' : 'topology.assignment.transfer',
            entityType: 'service_device_assignment',
            entityId: linked.id,
            metadata: {
              assignmentId: linked.id,
              previousBackboneDeviceId,
              nextBackboneDeviceId: linked.backboneDeviceId
            }
          });
        }
        return linked;
      })();
      return reply.send(assignment);
    } catch (error) {
      return repositoryError(reply, error);
    }
  });

  app.delete('/api/topology/assignments/:id/backbone', canManage, async (request, reply) => {
    const params = assignmentParamsSchema.safeParse(request.params);
    const body = clearAssignmentBackboneSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'Dados de associacao invalidos' });
    if (!activeAssignmentExists(params.data.id)) return reply.status(404).send({ error: 'Atribuicao ativa nao encontrada' });
    const previousBackboneDeviceId = activeBackboneIdForAssignment(params.data.id);
    try {
      const db = getSqliteDatabase();
      db.transaction(() => {
        clearAssignmentBackbone(db, params.data.id, body.data.reason, request.user?.id ?? null);
        recordAuditStrict(db, request, {
          action: 'topology.assignment.unlink',
          entityType: 'service_device_assignment',
          entityId: params.data.id,
          metadata: {
            assignmentId: params.data.id,
            previousBackboneDeviceId,
            nextBackboneDeviceId: null
          }
        });
      })();
      return reply.send({ assignmentId: params.data.id, backboneDeviceId: null });
    } catch (error) {
      return repositoryError(reply, error);
    }
  });
}
