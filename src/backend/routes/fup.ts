import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { listFupEvents, loadFupUsage, loadOperatorPool, previewFupImpact } from '../lib/fup';
import {
  FupSettingsError, bytesPerGb, candidateFupSettings, describeFupSettings, listFupSettingsHistory, readFupSettings, resetFupSetting, saveFupSettings
} from '../lib/fup-settings';
import { requestNetworkSync } from '../lib/network-sync';
import { recordAudit, recordAuditStrict } from '../lib/audit';
import { requireAuth, requireRole } from './auth';

const changesSchema = z.object({
  changes: z.record(z.string(), z.union([z.string(), z.number()])),
  reason: z.string().trim().max(500).optional().nullable()
});
const topupSchema = z.object({ gb: z.number().int().min(1).max(1_000_000), reason: z.string().trim().max(500).optional().nullable() });
const plafondSchema = z.object({ referenceGb: z.number().int().min(0).max(100_000).nullable() });
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
  serviceReferenceGb: row.serviceReferenceGb,
  inheritedReferenceGb: row.inheritedReferenceGb,
  peakPercent: row.peakPercent,
  cycleStart: row.cycle.start,
  cycleEnd: row.cycle.end,
  period: row.cycle.period,
  downloadBytes: row.downloadBytes,
  uploadBytes: row.uploadBytes,
  totalBytes: row.totalBytes,
  percent: row.percent,
  state: row.state,
  limitedNow: row.limitedNow,
  globalLimit: row.globalLimit
});

/** Política de uso justo: leitura para todos, escrita só do administrador. */
export async function registerFupRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };
  const authed = { preHandler: requireAuth() };

  app.get('/api/fup/settings', authed, async () => {
    const db = getSqliteDatabase();
    const last = db.prepare("SELECT summary_json AS summary FROM job_runs WHERE job IN ('network_enforcement', 'network_enforcement_manual') AND summary_json IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { summary: string } | undefined;
    let clockZone: string | null = null;
    try {
      const value: unknown = JSON.parse(last?.summary ?? '{}')?.fupQueues?.clockZone;
      if (typeof value === 'string' && value) clockZone = value;
    } catch { /* Resumo antigo ou inválido: o fuso é desconhecido. */ }
    return { settings: describeFupSettings(db), pool: loadOperatorPool(db, new Date(), readFupSettings(db)), routerClock: { clockZone, clockMismatch: clockZone === null ? null : clockZone !== readFupSettings(db).fuso_horario } };
  });

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

  // Recarga: GB comprados à operadora a meio do ciclo. Somam-se às do mesmo ciclo e caem na renovação.
  app.post('/api/fup/pool/topup', adminOnly, async (request, reply) => {
    const parsed = topupSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Indique os GB a adicionar (1 a 1 000 000).' });
    const db = getSqliteDatabase();
    const settings = readFupSettings(db);
    const pool = loadOperatorPool(db, new Date(), settings);
    if (!pool.enabled) return reply.status(400).send({ error: 'Defina primeiro o pacote da operadora.' });
    const total = pool.extraGb + parsed.data.gb;
    saveFupSettings(db, { pacote_extra_gb: String(total), pacote_extra_ciclo: pool.cycle.start }, request.user?.username ?? 'desconhecido', parsed.data.reason || 'Recarga do pacote');
    recordAudit(request, { action: 'fup.recarga', entityType: 'fup_settings', summary: `Adicionou ${parsed.data.gb} GB ao pacote da operadora (ciclo ${pool.cycle.start}, total extra ${total} GB)` });
    requestNetworkSync();
    return { pool: loadOperatorPool(db, new Date(), readFupSettings(db)), settings: describeFupSettings(db) };
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
        fuso_horario: raw.fuso_horario,
        plafond_predefinido_gb: Number(raw.plafond_predefinido_gb),
        dia_ciclo: raw.dia_ciclo,
        acao_ao_limite: raw.acao_ao_limite as typeof settings.acao_ao_limite,
        horario_limitacao: raw.horario_limitacao as typeof settings.horario_limitacao,
        pacote_operadora_gb: Number(raw.pacote_operadora_gb),
        pacote_extra_gb: Number(raw.pacote_extra_gb),
        pacote_extra_ciclo: raw.pacote_extra_ciclo,
        ligacoes_extra_pacote: Number(raw.ligacoes_extra_pacote),
        limiar_pacote_percent: Number(raw.limiar_pacote_percent)
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
      thresholds: { aviso: settings.limiar_aviso_percent, limitacao: settings.limiar_limitacao_percent, acao: settings.acao_ao_limite, bytesPerGb: bytesPerGb(settings) }
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
      thresholds: { aviso: settings.limiar_aviso_percent, limitacao: settings.limiar_limitacao_percent, acao: settings.acao_ao_limite, bytesPerGb: bytesPerGb(settings) },
      events: listFupEvents(db, id).map((event) => ({ ...event, detail: event.detailJson ? JSON.parse(event.detailJson) : null, detailJson: undefined }))
    };
  });

  // Plafond próprio do serviço (pacote extra ou exceção): nulo = herda, 0 = isento.
  app.put('/api/fup/services/:id/plafond', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Serviço inválido' });
    const parsed = plafondSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Plafond inválido: inteiro de 0 a 100 000 GB, ou vazio para herdar.' });
    const db = getSqliteDatabase();
    const current = db.prepare('SELECT fup_reference_gb AS gb FROM services WHERE id = ?').get(id) as { gb: number | null } | undefined;
    if (!current) return reply.status(404).send({ error: 'Serviço não encontrado' });
    const next = parsed.data.referenceGb;
    if (current.gb !== next) {
      const label = (gb: number | null) => (gb === null ? 'herda' : gb === 0 ? 'isento' : `${gb} GB`);
      // A alteração e o registo entram juntos: um plafond mudado sem rasto não fica.
      db.transaction(() => {
        db.prepare("UPDATE services SET fup_reference_gb = ?, updated_at = datetime('now') WHERE id = ?").run(next, id);
        recordAuditStrict(db, request, {
          action: 'fup.plafond', entityType: 'service', entityId: id,
          summary: `Plafond do serviço ${id}: ${label(current.gb)} → ${label(next)}`,
          metadata: { antes: current.gb, depois: next }
        });
      })();
      requestNetworkSync();
    }
    const settings = readFupSettings(db);
    const [row] = loadFupUsage(db, new Date(), settings, { serviceId: id });
    return { serviceReferenceGb: next, usage: row ? usageRow(row) : null };
  });
}
