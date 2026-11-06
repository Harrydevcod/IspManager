import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { listFupEvents, loadFupUsage, previewFupImpact } from '../lib/fup';
import {
  FupSettingsError, candidateFupSettings, describeFupSettings, listFupSettingsHistory, readFupSettings, resetFupSetting, saveFupSettings
} from '../lib/fup-settings';
import { requestNetworkSync } from '../lib/network-sync';
import { recordAudit } from '../lib/audit';
import { requireAuth, requireRole } from './auth';

const changesSchema = z.object({
  changes: z.record(z.string(), z.union([z.string(), z.number()])),
  reason: z.string().trim().max(500).optional().nullable()
});
const historySchema = z.object({
  key: z.string().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const usageRow = (row: ReturnType<typeof loadFupUsage>[number]) => ({
  serviceId: row.serviceId,
  clientId: row.clientId,
  username: row.username,
  planName: row.planName,
  referenceGb: row.referenceGb,
  peakPercent: row.peakPercent,
  cycleStart: row.cycle.start,
  cycleEnd: row.cycle.end,
  period: row.cycle.period,
  downloadBytes: row.downloadBytes,
  uploadBytes: row.uploadBytes,
  totalBytes: row.totalBytes,
  percent: row.percent,
  state: row.state,
  limitedNow: row.limitedNow
});

/** Política de uso justo: leitura para todos, escrita só do administrador. */
export async function registerFupRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };
  const authed = { preHandler: requireAuth() };

  app.get('/api/fup/settings', authed, async () => ({ settings: describeFupSettings(getSqliteDatabase()) }));

  app.put('/api/fup/settings', adminOnly, async (request, reply) => {
    const parsed = changesSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Dados inválidos' });
    const db = getSqliteDatabase();
    try {
      const { changed } = saveFupSettings(db, parsed.data.changes, request.user?.username ?? 'desconhecido', parsed.data.reason);
      if (changed.length > 0) {
        recordAudit(request, { action: 'fup.configuracao', entityType: 'fup_settings', summary: `Alterou a configuração FUP: ${changed.join(', ')}` });
        requestNetworkSync();
      }
      return { changed, settings: describeFupSettings(db) };
    } catch (err) {
      if (err instanceof FupSettingsError) return reply.status(400).send({ error: 'Configuração inválida', errors: err.errors });
      throw err;
    }
  });

  app.post('/api/fup/settings/:key/reset', adminOnly, async (request, reply) => {
    const { key } = request.params as { key: string };
    const db = getSqliteDatabase();
    try {
      const { changed } = resetFupSetting(db, key, request.user?.username ?? 'desconhecido');
      if (changed.length > 0) {
        recordAudit(request, { action: 'fup.configuracao', entityType: 'fup_settings', summary: `Repôs o default de ${key}` });
        requestNetworkSync();
      }
      return { changed, settings: describeFupSettings(db) };
    } catch (err) {
      if (err instanceof FupSettingsError) return reply.status(400).send({ error: 'Configuração inválida', errors: err.errors });
      throw err;
    }
  });

  app.get('/api/fup/history', authed, async (request, reply) => {
    const parsed = historySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Filtro inválido' });
    return { history: listFupSettingsHistory(getSqliteDatabase(), parsed.data) };
  });

  // Pré-visualização: a configuração candidata contra o ciclo corrente. Não grava nada.
  app.post('/api/fup/preview', authed, async (request, reply) => {
    const parsed = changesSchema.pick({ changes: true }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Dados inválidos' });
    const db = getSqliteDatabase();
    try {
      const { raw, errors } = candidateFupSettings(db, parsed.data.changes);
      if (Object.keys(errors).length > 0) return reply.status(400).send({ error: 'Configuração inválida', errors });
      const settings = readFupSettings(db);
      const candidate = {
        ...settings,
        limiar_aviso_percent: Number(raw.limiar_aviso_percent),
        limiar_limitacao_percent: Number(raw.limiar_limitacao_percent),
        percent_velocidade_pico: Number(raw.percent_velocidade_pico),
        fuso_horario: raw.fuso_horario
      };
      return { current: previewFupImpact(db, new Date(), settings), candidate: previewFupImpact(db, new Date(), candidate) };
    } catch (err) {
      if (err instanceof FupSettingsError) return reply.status(400).send({ error: 'Configuração inválida', errors: err.errors });
      throw err;
    }
  });

  app.get('/api/fup/usage', authed, async () => {
    const db = getSqliteDatabase();
    const settings = readFupSettings(db);
    return {
      usage: loadFupUsage(db, new Date(), settings).map(usageRow),
      thresholds: { aviso: settings.limiar_aviso_percent, limitacao: settings.limiar_limitacao_percent }
    };
  });

  app.get('/api/fup/services/:id', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Serviço inválido' });
    const db = getSqliteDatabase();
    const settings = readFupSettings(db);
    const [row] = loadFupUsage(db, new Date(), settings, { serviceId: id });
    if (!row) return reply.status(404).send({ error: 'Serviço sem utilizador PPPoE' });
    return {
      usage: usageRow(row),
      thresholds: { aviso: settings.limiar_aviso_percent, limitacao: settings.limiar_limitacao_percent },
      events: listFupEvents(db, id).map((event) => ({ ...event, detail: event.detailJson ? JSON.parse(event.detailJson) : null, detailJson: undefined }))
    };
  });
}
