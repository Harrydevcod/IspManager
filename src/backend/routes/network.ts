import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { loadNetworkStatus, loadProbeEvents, mapWithLimit, readProbeConfig, runNetworkProbe } from '../lib/network-probe';
import {
  createTransport,
  DEFAULT_ROUTER_PORT,
  describeRouterFailure,
  diagnoseRouter,
  isRouterConfigured,
  listArp,
  listDhcpLeases,
  listNeighbors,
  listActive,
  listSecrets,
  removeActive,
  neighborModel,
  readRouterConfig,
  type RouterNeighbor
} from '../lib/routeros';
import { identifyModel } from '../lib/device-model';
import { loadNetworkEnforcementState, matchSecret, runNetworkEnforcement } from '../lib/network-enforcement';
import { loadAutoSuspensionPreview, runAutomaticSuspension } from '../lib/auto-suspension';
import {
  loadRegisteredDevices,
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
import { buildProposals, dismissalKey, findOrphans, type ProposalKind } from '../lib/discovery-reconcile';
import { runJob } from '../lib/jobRuns';
import { recordAudit } from '../lib/audit';
import { isIpv4, isPrivateIpv4, SWEEP_BATCH_SIZE } from '../../shared/ip-range';
import { requireAuth, requireRole } from './auth';
import { SECRET_MASK } from './settings';

const serviceParamsSchema = z.object({
  id: z.coerce.number().int().positive()
}).strict();

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

const dismissBodySchema = z.object({
  kind: z.enum(['mac_em_falta', 'ip_em_falta', 'ip_mudou', 'modelo_diferente', 'backbone_ausente']),
  targetKind: z.enum(['backbone', 'assignment']),
  targetId: z.number().int().positive()
}).strict();

const contextBodySchema = z.object({
  // O intervalo varrido, já expandido pelo renderer. Vazio quando a aba abre
  // sem ninguém ter varrido nada ainda.
  rangeIps: z.array(z.string()).max(1024).default([]),
  alive: z.array(z.object({
    ip: z.string(),
    rttMs: z.number().nullable(),
    /** O que o DNS inverso respondeu durante o varrimento, se respondeu. */
    hostname: z.string().max(253).nullish()
  })).max(1024).default([]),
  includeRouter: z.boolean().default(true)
}).strict();

/**
 * Os campos do router tal como estao no formulario. Todos opcionais: sem corpo,
 * o teste corre contra o que esta gravado, como antes.
 */
const routerTestBodySchema = z.object({
  host: z.string().trim().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_ROUTER_PORT).optional(),
  user: z.string().trim().max(64).optional(),
  password: z.string().max(128).optional(),
  tlsCert: z.string().trim().max(8000).optional()
}).strict();

export async function registerNetworkRoutes(app: FastifyInstance) {
  const readOnly = { preHandler: requireAuth() };
  const adminOnly = { preHandler: requireRole(['admin']) };
  const networkWrite = { preHandler: requireRole(['admin', 'operator']) };

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
      configured: isRouterConfigured(config),
      autoSuspension: loadAutoSuspensionPreview(db)
    };
  });

  // Avalia a cobrança sem contornar o ensaio. Em LIVE muda a intenção do
  // serviço; a reconciliação continua responsável pela escrita no MikroTik.
  app.post('/api/network/auto-suspension', adminOnly, async () => {
    const db = getSqliteDatabase();
    return runJob('auto_suspension_manual', async () => runAutomaticSuspension(db));
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
      // Mesma tradução do teste: `connect ECONNREFUSED` não diz a ninguém que
      // o que falta é ligar o www-ssl.
      const failure = describeRouterFailure(err);
      return reply.status(502).send({ error: `${failure.title}. ${failure.detail}` });
    }
  });

  /**
   * Reconcilia apenas um serviço PPPoE. É a ação "Sincronizar" da ficha do
   * cliente; os secrets dos restantes serviços não são tratados como órfãos.
   */
  app.post('/api/network/services/:id/sync', networkWrite, async (request, reply) => {
    const params = serviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Servico invalido' });

    const db = getSqliteDatabase();
    const config = readRouterConfig(db);
    if (!config.enabled || !isRouterConfigured(config)) {
      return reply.status(400).send({ error: 'Integração MikroTik desligada ou por configurar' });
    }

    const exists = db.prepare('SELECT id FROM services WHERE id = ?').get(params.data.id);
    if (!exists) return reply.status(404).send({ error: 'Servico nao encontrado' });

    try {
      const result = await runJob('network_enforcement_service_manual', () => runNetworkEnforcement(db, {
        transport: createTransport(config),
        dryRun: config.dryRun,
        maxDisables: config.maxDisablesPerRun,
        serviceIds: [params.data.id],
        reportOrphans: false
      }));

      recordAudit(request, {
        action: config.dryRun ? 'network_sync_dry_run' : 'network_sync_manual',
        entityType: 'service',
        entityId: params.data.id,
        summary: config.dryRun
          ? `Simulou sincronização de rede do serviço ${params.data.id}`
          : `Sincronizou a rede do serviço ${params.data.id}`,
        metadata: {
          dryRun: config.dryRun,
          planned: result.planned,
          applied: result.applied,
          failed: result.failed
        }
      });
      return result;
    } catch (err) {
      const failure = describeRouterFailure(err);
      return reply.status(502).send({ error: `${failure.title}. ${failure.detail}`, code: failure.code });
    }
  });

  /**
   * Derruba somente a sessão PPPoE atual. Não suspende o serviço e não altera o
   * secret; o cliente pode voltar a autenticar-se logo a seguir.
   */
  app.post('/api/network/services/:id/disconnect', networkWrite, async (request, reply) => {
    const params = serviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Servico invalido' });

    const db = getSqliteDatabase();
    const service = db.prepare(`
      SELECT pppoe_username AS username
      FROM services
      WHERE id = ?
    `).get(params.data.id) as { username: string | null } | undefined;

    if (!service) return reply.status(404).send({ error: 'Servico nao encontrado' });
    if (!service.username?.trim()) {
      return reply.status(409).send({ error: 'Este servico ainda nao tem utilizador PPPoE' });
    }

    const config = readRouterConfig(db);
    if (!config.enabled || !isRouterConfigured(config)) {
      return reply.status(400).send({ error: 'Integração MikroTik desligada ou por configurar' });
    }

    try {
      const transport = createTransport(config);
      const [secrets, active] = await Promise.all([listSecrets(transport), listActive(transport)]);
      // A sessão tem o nome do secret no router, que pode ter sido renomeado.
      const login = matchSecret({ serviceId: params.data.id, username: service.username }, secrets)?.name
        ?? service.username;
      const session = active.find((item) => item.name === login);

      if (config.dryRun) {
        recordAudit(request, {
          action: 'network_disconnect_dry_run',
          entityType: 'service',
          entityId: params.data.id,
          summary: session
            ? `Simulou desconexão PPPoE de ${service.username}`
            : `Simulou desconexão de ${service.username}, sem sessão ativa`,
          metadata: { online: Boolean(session) }
        });
        return { dryRun: true, online: Boolean(session), disconnected: false };
      }

      if (!session) {
        return { dryRun: false, online: false, disconnected: false };
      }

      await removeActive(transport, session.id);
      recordAudit(request, {
        action: 'network_disconnect_manual',
        entityType: 'service',
        entityId: params.data.id,
        summary: `Desconectou a sessão PPPoE de ${service.username}`
      });
      return { dryRun: false, online: true, disconnected: true };
    } catch (err) {
      const failure = describeRouterFailure(err);
      return reply.status(502).send({ error: `${failure.title}. ${failure.detail}`, code: failure.code });
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
      // Só rede local entra. O router de gestão encaminha as duas WAN Starlink e
      // reporta-as no ARP como reporta tudo o resto — endereços CGNAT
      // (100.64.0.0/10) que nunca foram varridos e não são equipamento nenhum.
      // A Descoberta é um inventário da rede local, não da internet.
      if (!isIpv4(ip) || !isPrivateIpv4(ip)) return;
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

    // O nome do DNS inverso **não entra pelo `attach`**, e não é distração.
    //
    // Pelo `attach` ia parar ao `observed`, e o `observed` é o que se escreve.
    // A escrita é um `COALESCE`: o primeiro nome que entra na linha fica lá para
    // sempre. Congelar assim o mais fraco dos três nomes — o `identity` é o que
    // o aparelho tem configurado, o `host-name` é o que ele anunciou ao pedir
    // endereço, e isto é uma entrada de DNS que alguém criou e pode não ter
    // apagado — daria ao palpite a permanência que só o facto merece.
    //
    // Segue à parte, para o cruzamento o usar como último recurso: preenche o
    // que ficou vazio, não vai para a base, e recalcula-se no varrimento
    // seguinte.
    const dnsNames: Record<string, string> = {};
    for (const entry of alive) {
      if (entry.hostname && isIpv4(entry.ip)) dnsNames[entry.ip] = entry.hostname;
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
      registered: loadRegisteredDevices(db),
      seen: loadSeenHosts(db),
      dnsNames
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

  /**
   * O que a rede sabe e o registo ainda não — em forma de propostas.
   *
   * **Não escreve nada.** Aplicar é sempre um botão, e o botão chama as rotas de
   * equipamento que já existem (`PATCH /api/service-device-assignments`,
   * `PUT /api/topology/backbones/:id`, `POST .../replace`) com as validações que
   * elas já têm. Se esta rota escrevesse, a descoberta passava a ser uma segunda
   * porta para o registo, com metade das regras.
   */
  app.get('/api/network/discovery/proposals', readOnly, async () => {
    const db = getSqliteDatabase();
    const devices = loadRegisteredDevices(db);
    const hosts = loadSeenHosts(db);

    const dismissed = new Set(
      (db.prepare(`SELECT kind, target_kind AS targetKind, target_id AS targetId FROM network_discovery_dismissals`)
        .all() as Array<{ kind: ProposalKind; targetKind: string; targetId: number }>)
        .map((row) => dismissalKey(row.kind, row.targetKind, row.targetId))
    );

    const claimedIps = new Set(devices.flatMap((device) => (device.ip ? [device.ip] : [])));
    return {
      proposals: buildProposals({ devices, hosts, dismissed }),
      orphans: findOrphans(devices, hosts, claimedIps)
    };
  });

  // Dispensar é a única escrita desta família de rotas — e escreve sobre a
  // proposta, nunca sobre o equipamento.
  app.post('/api/network/discovery/dismiss', readOnly, async (request, reply) => {
    const parsed = dismissBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }
    const { kind, targetKind, targetId } = parsed.data;
    const db = getSqliteDatabase();

    db.prepare(`
      INSERT OR IGNORE INTO network_discovery_dismissals (kind, target_kind, target_id, dismissed_by)
      VALUES (?, ?, ?, ?)
    `).run(kind, targetKind, targetId, request.user?.id ?? null);

    recordAudit(request, {
      action: 'network_discovery_dismiss',
      entityType: targetKind === 'backbone' ? 'backbone_device' : 'service_device_assignment',
      entityId: targetId,
      summary: kind
    });

    return { ok: true };
  });

  // Teste de ligação ao MikroTik. Só lê `/system/resource`: serve para provar
  // credenciais e certificado antes de alguém ligar a reconciliação.
  /**
   * Diagnostico da ligacao ao router de gestao.
   *
   * Aceita os valores do formulario no corpo, em vez de ler so o que esta
   * gravado: quem acaba de escrever o endereco quer testar **esse**, nao o
   * antigo. Nada do que vem no corpo e gravado — testar nao e configurar.
   *
   * A senha volta mascarada ao formulario, por isso a mascara significa "a que
   * ja esta guardada"; so uma senha escrita de novo substitui essa.
   *
   * Responde sempre 200: o relatorio e que diz o que passou e o que falhou.
   */
  app.post('/api/network/router/test', adminOnly, async (request, reply) => {
    const parsed = routerTestBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Parametros invalidos' });
    }

    const saved = readRouterConfig(getSqliteDatabase());
    const override = parsed.data;
    const config = {
      ...saved,
      host: override.host ?? saved.host,
      port: override.port ?? saved.port,
      user: override.user ?? saved.user,
      password:
        override.password === undefined || override.password === SECRET_MASK
          ? saved.password
          : override.password,
      tlsCert: override.tlsCert ?? saved.tlsCert
    };

    return diagnoseRouter(config);
  });
}
