import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { loadNetworkStatus, loadProbeEvents, mapWithLimit, readProbeConfig, runNetworkProbe } from '../lib/network-probe';
import {
  createTransport,
  fetchRouterCertificate,
  isRouterConfigured,
  listArp,
  listDhcpLeases,
  listNeighbors,
  neighborModel,
  readRouterConfig,
  RouterError,
  testConnection,
  type RouterNeighbor
} from '../lib/routeros';
import { identifyModel } from '../lib/device-model';
import { loadNetworkEnforcementState, runNetworkEnforcement } from '../lib/network-enforcement';
import {
  loadRegisteredIps,
  loadSeenHosts,
  normalizeMac,
  persistModel,
  persistSeen,
  readLocalArp,
  resolveNames,
  sweep,
  type DiscoveredHost
} from '../lib/network-discovery';
import { crossReference, type ObservedHost } from '../lib/network-inventory';
import { runJob } from '../lib/jobRuns';
import { recordAudit } from '../lib/audit';
import { isIpv4, SWEEP_BATCH_SIZE } from '../../shared/ip-range';
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

const sweepBodySchema = z.object({
  ips: z.array(z.string()).min(1).max(SWEEP_BATCH_SIZE),
  range: z.string().min(1).max(64),
  batchIndex: z.number().int().min(0)
}).strict();

const identifyBodySchema = z.object({
  ips: z.array(z.string()).min(1).max(SWEEP_BATCH_SIZE),
  batchIndex: z.number().int().min(0).default(0)
}).strict();

/**
 * Mais apertado que o do varrimento (32): aqui cada endereço pode custar um
 * timeout de SNMP **e** um aperto de mão TCP a seguir, e o alvo é equipamento
 * de cliente com CPU de router doméstico, não a nossa máquina.
 */
const IDENTIFY_CONCURRENCY = 8;

const contextBodySchema = z.object({
  // O intervalo varrido, já expandido pelo renderer. Vazio quando a aba abre
  // sem ninguém ter varrido nada ainda.
  rangeIps: z.array(z.string()).max(1024).default([]),
  alive: z.array(z.object({
    ip: z.string(),
    rttMs: z.number().nullable()
  })).max(1024).default([]),
  includeRouter: z.boolean().default(true)
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

  // ------------------------------------------------------ descoberta de rede

  /**
   * Varre um lote de endereços. **Só ICMP** — sem ARP e sem router, que são
   * caros e globais e por isso vivem na rota de contexto. O varrimento chega em
   * lotes para a barra de progresso ser real e o botão de parar funcionar; se
   * cada lote também lesse a tabela ARP e chamasse o MikroTik, um /24 fazia esse
   * trabalho quatro vezes para dar exatamente a mesma resposta.
   */
  app.post('/api/network/discovery/sweep', readOnly, async (request, reply) => {
    const parsed = sweepBodySchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.ips.every(isIpv4)) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }
    const { ips, range, batchIndex } = parsed.data;

    // Uma linha de auditoria por varrimento, não por lote (ADR 0007: nada
    // acontece sem rasto, mas o rasto é do ato, não do transporte).
    if (batchIndex === 0) {
      recordAudit(request, {
        action: 'network_discovery_scan',
        entityType: 'network',
        summary: range,
        metadata: { range }
      });
    }

    const results = await runJob('network_discovery_sweep', () => sweep(ips));
    const alive = results.filter((row) => row.ok).map((row) => row.ip);
    // DNS inverso só sobre quem respondeu — perguntar por 254 endereços mortos
    // é esperar 254 timeouts para não descobrir nada.
    const names = await resolveNames(alive);

    return {
      results: results.map((row) => ({ ...row, hostname: names.get(row.ip) ?? null }))
    };
  });

  /**
   * O retrato completo: junta o que respondeu ao ARP local, ao ARP/leases do
   * router, ao histórico e ao que o ISPM diz que devia lá estar.
   *
   * É `POST` porque escreve (o histórico) e porque recebe a lista de endereços
   * vivos, que não cabe numa query string.
   */
  app.post('/api/network/discovery', readOnly, async (request, reply) => {
    const parsed = contextBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }
    const { rangeIps, alive, includeRouter } = parsed.data;
    const db = getSqliteDatabase();

    const byIp = new Map<string, ObservedHost>();
    for (const entry of alive) {
      if (!isIpv4(entry.ip)) continue;
      byIp.set(entry.ip, { ip: entry.ip, mac: null, hostname: null, source: 'ping', rttMs: entry.rttMs });
    }

    const attach = (ip: string, mac: string | null, hostname: string | null, source: ObservedHost['source']) => {
      if (!isIpv4(ip)) return;
      const existing = byIp.get(ip);
      if (existing) {
        existing.mac = existing.mac ?? mac;
        existing.hostname = existing.hostname ?? hostname;
        return;
      }
      // Um equipamento que ignora ICMP mas está na tabela ARP está na rede na
      // mesma — e é justamente o que um firewall bem configurado faz.
      byIp.set(ip, { ip, mac, hostname, source, rttMs: null });
    };

    for (const entry of await readLocalArp()) attach(entry.ip, entry.mac, null, 'arp');

    let routerEnriched = false;
    let routerNeighbors: RouterNeighbor[] = [];
    const config = readRouterConfig(db);
    if (includeRouter && isRouterConfigured(config)) {
      const transport = createTransport(config);
      // Cada chamada falha por si: o router em baixo nunca pode derrubar a
      // página, só tira-lhe o enriquecimento.
      const [arp, leases, neighbors] = await Promise.all([
        listArp(transport).catch(() => null),
        listDhcpLeases(transport).catch(() => null),
        listNeighbors(transport).catch(() => null)
      ]);
      routerEnriched = arp !== null || leases !== null || neighbors !== null;
      for (const entry of arp ?? []) attach(entry.address, normalizeMac(entry.macAddress), null, 'router');
      for (const lease of leases ?? []) {
        attach(lease.address, normalizeMac(lease.macAddress), lease.hostName, 'router');
      }
      // Os vizinhos são a única fonte de modelo que não custa um pacote por
      // equipamento: uma pergunta ao router e vem o que cada um já anunciou
      // sozinho. O `identity` também serve de nome onde o DNS inverso calou.
      for (const neighbor of neighbors ?? []) {
        attach(neighbor.address, normalizeMac(neighbor.macAddress), neighbor.identity, 'router');
      }
      routerNeighbors = neighbors ?? [];
    }

    const observed = [...byIp.values()];
    persistSeen(db, observed.map((host): DiscoveredHost => ({
      ip: host.ip,
      mac: host.mac,
      hostname: host.hostname,
      source: host.source
    })));

    // Depois do `persistSeen`, que é quem garante que a linha do endereço já
    // existe para o modelo ter onde pousar.
    for (const neighbor of routerNeighbors) {
      const model = neighborModel(neighbor);
      if (!model || !isIpv4(neighbor.address)) continue;
      persistModel(db, {
        ip: neighbor.address,
        model,
        source: 'router',
        detail: [neighbor.platform, neighbor.board, neighbor.version].filter(Boolean).join(' ') || null
      });
    }

    const report = crossReference({
      rangeIps,
      observed,
      registered: loadRegisteredIps(db),
      seen: loadSeenHosts(db)
    });

    return { ...report, routerEnriched, routerConfigured: isRouterConfigured(config) };
  });

  /**
   * Perguntar a cada equipamento que aparelho ele é.
   *
   * Rota à parte do varrimento por uma razão prática: sondar é lento (um
   * datagrama SNMP com timeout, e uma ligação TCP quando o SNMP cala) e a
   * interface tem de conseguir mostrar progresso e ser interrompida a meio. Em
   * lotes, exatamente como o varrimento já faz.
   *
   * Também é o único ponto do ISPM que toca em equipamento de cliente sem ser
   * por ICMP — daí a linha de auditoria e daí ficar desligado por omissão na
   * interface.
   */
  app.post('/api/network/discovery/identify', readOnly, async (request, reply) => {
    const parsed = identifyBodySchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.ips.every(isIpv4)) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }
    const { ips, batchIndex } = parsed.data;
    const db = getSqliteDatabase();

    if (batchIndex === 0) {
      recordAudit(request, {
        action: 'network_discovery_identify',
        entityType: 'network',
        summary: `${ips.length} endereco(s)`,
        metadata: { first: ips[0] }
      });
    }

    const probes = await runJob('network_discovery_identify', () =>
      mapWithLimit(ips, IDENTIFY_CONCURRENCY, async (ip) => ({ ip, probe: await identifyModel(ip) }))
    );

    for (const { ip, probe } of probes) {
      if (!probe) continue;
      persistModel(db, { ip, model: probe.model, source: probe.source, detail: probe.detail });
    }

    return {
      results: probes.map(({ ip, probe }) => ({
        ip,
        model: probe?.model ?? null,
        modelSource: probe?.model ? probe.source : null
      }))
    };
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
