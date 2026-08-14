import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireAuth, requireRole } from './auth';

const planSchema = z.object({
  name: z.string().trim().min(1),
  downloadSpeed: z.string().trim().min(1),
  uploadSpeed: z.string().trim().min(1),
  connectionType: z.enum(['radio', 'fibra', 'cabo', 'outro']).default('outro'),
  monthlyPriceCve: z.coerce.number().min(0),
  installationFeeCve: z.coerce.number().min(0).default(0),
  description: z.string().trim().optional().nullable(),
  // Velocidade legivel por maquina: e daqui que sai o rate-limit no MikroTik.
  // Nulo = sem limite definido; a reconciliacao nao adivinha a partir do texto.
  downloadMbps: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  uploadMbps: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  active: z.coerce.boolean().default(true)
});

export async function registerPlanRoutes(app: FastifyInstance) {
  const canWritePlans = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/plans', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    return db.prepare(`
      SELECT
        id,
        name,
        download_speed AS downloadSpeed,
        upload_speed AS uploadSpeed,
        connection_type AS connectionType,
        monthly_price_cve AS monthlyPriceCve,
        installation_fee_cve AS installationFeeCve,
        download_mbps AS downloadMbps,
        upload_mbps AS uploadMbps,
        description,
        active,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM internet_plans
      ORDER BY active DESC, monthly_price_cve, name
    `).all();
  });

  app.get('/api/plans/:id', { preHandler: requireAuth() }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const db = getSqliteDatabase();
    const plan = db.prepare(`
      SELECT
        id,
        name,
        download_speed AS downloadSpeed,
        upload_speed AS uploadSpeed,
        connection_type AS connectionType,
        monthly_price_cve AS monthlyPriceCve,
        installation_fee_cve AS installationFeeCve,
        download_mbps AS downloadMbps,
        upload_mbps AS uploadMbps,
        description,
        active
      FROM internet_plans
      WHERE id = ?
    `).get(id);

    if (!plan) {
      return reply.status(404).send({ error: 'Plano nao encontrado' });
    }

    return plan;
  });

  app.post('/api/plans', canWritePlans, async (request, reply) => {
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de plano invalidos' });
    }

    const db = getSqliteDatabase();
    const result = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve,
        installation_fee_cve, description, active, download_mbps, upload_mbps, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      parsed.data.name,
      parsed.data.downloadSpeed,
      parsed.data.uploadSpeed,
      parsed.data.connectionType,
      parsed.data.monthlyPriceCve,
      parsed.data.installationFeeCve,
      parsed.data.description || null,
      parsed.data.active ? 1 : 0,
      parsed.data.downloadMbps ?? null,
      parsed.data.uploadMbps ?? null
    );

    return reply.status(201).send({ id: result.lastInsertRowid });
  });

  app.put('/api/plans/:id', canWritePlans, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = planSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de plano invalidos' });
    }

    const db = getSqliteDatabase();
    const result = db.prepare(`
      UPDATE internet_plans
      SET name = ?,
          download_speed = ?,
          upload_speed = ?,
          connection_type = ?,
          monthly_price_cve = ?,
          installation_fee_cve = ?,
          description = ?,
          active = ?,
          download_mbps = ?,
          upload_mbps = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      parsed.data.name,
      parsed.data.downloadSpeed,
      parsed.data.uploadSpeed,
      parsed.data.connectionType,
      parsed.data.monthlyPriceCve,
      parsed.data.installationFeeCve,
      parsed.data.description || null,
      parsed.data.active ? 1 : 0,
      parsed.data.downloadMbps ?? null,
      parsed.data.uploadMbps ?? null,
      id
    );

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Plano nao encontrado' });
    }

    return { ok: true };
  });
}
