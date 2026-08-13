import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { loadNetworkStatus, loadProbeEvents, readProbeConfig, runNetworkProbe } from '../lib/network-probe';
import {
  createTransport,
  fetchRouterCertificate,
  isRouterConfigured,
  readRouterConfig,
  RouterError,
  testConnection
} from '../lib/routeros';
import { loadNetworkEnforcementState, runNetworkEnforcement } from '../lib/network-enforcement';
import { runJob } from '../lib/jobRuns';
import { requireAuth, requireRole } from './auth';

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
  const adminOnly = { preHandler: requireRole(['admin']) };

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

  // Estado do router por serviço: quem está online e onde há divergência.
  app.get('/api/network/enforcement', readOnly, async () => {
    const db = getSqliteDatabase();
    const config = readRouterConfig(db);
    return {
      ...loadNetworkEnforcementState(db),
      enabled: config.enabled,
      dryRun: config.dryRun,
      configured: isRouterConfigured(config)
    };
  });

  // "Reconciliar agora": corre uma passagem sem esperar pelo intervalo. Respeita
  // o ensaio — o botão nunca é um atalho para cortar clientes.
  app.post('/api/network/enforce', adminOnly, async (_request, reply) => {
    const db = getSqliteDatabase();
    const config = readRouterConfig(db);
    if (!isRouterConfigured(config)) {
      return reply.status(400).send({ error: 'Configure primeiro o endereco e o utilizador do router' });
    }
    try {
      return await runJob('network_enforcement_manual', () => runNetworkEnforcement(db, {
        transport: createTransport(config),
        dryRun: config.dryRun,
        maxDisables: config.maxDisablesPerRun
      }));
    } catch (err) {
      return reply.status(502).send({
        error: err instanceof RouterError ? err.message : 'Falha ao contactar o router'
      });
    }
  });

  // Teste de ligação ao MikroTik. Só lê `/system/resource`: serve para provar
  // credenciais e certificado antes de alguém ligar a reconciliação.
  app.post('/api/network/router/test', adminOnly, async (_request, reply) => {
    const config = readRouterConfig(getSqliteDatabase());
    if (!isRouterConfigured(config)) {
      return reply.status(400).send({ error: 'Configure primeiro o endereco e o utilizador do router' });
    }
    try {
      const info = await testConnection(createTransport(config));
      return { ok: true, ...info };
    } catch (err) {
      const routerError = err instanceof RouterError ? err : null;
      // Certificado proprio: le-o num aperto de mao sem credenciais para a UI
      // poder mostrar a impressao digital e propor fixa-la — em vez de sugerir
      // a alguem desligar a verificacao de TLS.
      let certificate: { pem: string; fingerprint: string } | null = null;
      if (routerError?.certIssue === 'untrusted') {
        certificate = await fetchRouterCertificate(config).catch(() => null);
      }
      return reply.status(502).send({
        error: routerError?.message ?? (err instanceof Error ? err.message : 'Falha ao contactar o router'),
        fingerprint: certificate?.fingerprint ?? null,
        certificate: certificate?.pem ?? null
      });
    }
  });
}
