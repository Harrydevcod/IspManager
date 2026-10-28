import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from '../lib/admin-network';
import { recordAuditStrict } from '../lib/audit';
import { canonicalHost, loadAntennaMacs, loadIptvTargets, readIptvConfig } from '../lib/iptv';
import { evaluateIptvInfra, listIptvTunnels, type IptvInfraReads } from '../lib/iptv-health';
import { cidrOverlaps, validateIptvSource } from '../lib/iptv-validate';
import { requestNetworkSync, runExclusive } from '../lib/network-sync';
import {
  createTransport, describeRouterFailure, isRouterConfigured, listActive, listArp, listDhcpLeases, listIpAddresses,
  readForwardFilter, readInterfaceListMembers, readInterfaces, readMangle, readRouterConfig, readRoutes, readSrcnat, readWireguardPeers,
  type RouterTransport
} from '../lib/routeros';
import { requireAuth, requireRole } from './auth';

const MAX_HOST_LINES = 50;

const markSchema = z.object({ iptvVpn: z.boolean(), iptvProviderId: z.number().int().positive().nullable() });
const providerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  hosts: z.string().default(''),
  notes: z.string().trim().max(500).nullish(),
  active: z.boolean().default(true)
});
// O PUT é parcial: sem defaults, para o que não vem ficar como está.
const updateSchema = z.object({
  name: providerSchema.shape.name.optional(),
  hosts: z.string().optional(),
  notes: providerSchema.shape.notes,
  active: z.boolean().optional()
});

/** Uma linha por host; as vazias ignoram-se. Guarda a forma canónica, sem repetidos. */
function parseHosts(text: string): { hosts: string } | { error: string } {
  const lines = text.split(/\r?\n/).map((raw, i) => ({ line: i + 1, value: raw.trim() })).filter((l) => l.value);
  if (lines.length > MAX_HOST_LINES) return { error: `No máximo ${MAX_HOST_LINES} hosts por fornecedor` };
  const canonical: string[] = [];
  for (const { line, value } of lines) {
    const host = canonicalHost(value);
    if (host === null) return { error: `Host inválido na linha ${line}: ${value}` };
    if (!canonical.includes(host)) canonical.push(host);
  }
  return { hosts: canonical.join('\n') };
}

const PROVIDER_COLUMNS = 'id, name, hosts, notes, active, created_at AS createdAt, updated_at AS updatedAt';

/**
 * As rotas que leem o router: só na rede de gestão e na fila das escritas do router
 * (nunca em paralelo com a passagem). Devolve null depois de responder com o erro.
 */
async function withRouter<T>(reply: FastifyReply, read: (transport: RouterTransport) => Promise<T>): Promise<T | null> {
  const db = getSqliteDatabase();
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) {
    reply.status(409).send({ error: 'A integração com o router está desligada ou por configurar' });
    return null;
  }
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) {
    reply.status(409).send({ error: offNetworkReason(presence) });
    return null;
  }
  try {
    return await runExclusive(() => read(createTransport(config)));
  } catch (err) {
    const failure = describeRouterFailure(err);
    reply.status(502).send({ error: `${failure.title}. ${failure.detail}` });
    return null;
  }
}

export async function registerIptvRoutes(app: FastifyInstance) {
  const operators = { preHandler: requireRole(['admin', 'operator']) };
  const adminOnly = { preHandler: requireRole(['admin']) };

  app.put('/api/services/:id/iptv', operators, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = markSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) return reply.status(400).send({ error: 'Dados de IPTV inválidos' });
    const db = getSqliteDatabase();
    const before = db.prepare('SELECT iptv_vpn AS iptvVpn, iptv_provider_id AS iptvProviderId FROM services WHERE id = ?').get(id) as
      { iptvVpn: number; iptvProviderId: number | null } | undefined;
    if (!before) return reply.status(404).send({ error: 'Serviço não encontrado' });
    const { iptvVpn, iptvProviderId } = parsed.data;
    // Ao desmarcar o fornecedor não conta: grava-se null em vez de validar um id que já não se usa.
    if (iptvVpn && iptvProviderId !== null) {
      const provider = db.prepare('SELECT active FROM iptv_providers WHERE id = ?').get(iptvProviderId) as { active: number } | undefined;
      if (!provider || !provider.active) return reply.status(400).send({ error: 'Fornecedor de IPTV inexistente ou inactivo' });
    }
    const after = { iptvVpn: iptvVpn ? 1 : 0, iptvProviderId: iptvVpn ? iptvProviderId : null };
    db.transaction(() => {
      db.prepare("UPDATE services SET iptv_vpn = ?, iptv_provider_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(after.iptvVpn, after.iptvProviderId, id);
      recordAuditStrict(db, request, {
        action: 'service_iptv_vpn', entityType: 'service', entityId: id,
        summary: `${iptvVpn ? 'Marcou' : 'Desmarcou'} o serviço ${id} para IPTV via VPN`,
        metadata: { before, after }
      });
    })();
    requestNetworkSync();
    return { serviceId: id, ...after };
  });

  app.get('/api/iptv/providers', { preHandler: requireAuth() }, async () =>
    getSqliteDatabase().prepare(`SELECT ${PROVIDER_COLUMNS} FROM iptv_providers ORDER BY active DESC, name`).all());

  app.post('/api/iptv/providers', adminOnly, async (request, reply) => {
    const parsed = providerSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Dados do fornecedor inválidos' });
    const hosts = parseHosts(parsed.data.hosts);
    if ('error' in hosts) return reply.status(400).send({ error: hosts.error });
    const db = getSqliteDatabase();
    const created = db.transaction(() => {
      const { lastInsertRowid } = db.prepare('INSERT INTO iptv_providers (name, hosts, notes, active) VALUES (?, ?, ?, ?)')
        .run(parsed.data.name, hosts.hosts, parsed.data.notes ?? null, parsed.data.active ? 1 : 0);
      const provider = db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM iptv_providers WHERE id = ?`).get(lastInsertRowid);
      recordAuditStrict(db, request, {
        action: 'iptv_provider_create', entityType: 'iptv_provider', entityId: Number(lastInsertRowid),
        summary: `Criou o fornecedor de IPTV ${parsed.data.name}`, metadata: { before: null, after: provider }
      });
      return provider;
    })();
    requestNetworkSync();
    return reply.status(201).send(created);
  });

  app.put('/api/iptv/providers/:id', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = updateSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) return reply.status(400).send({ error: 'Dados do fornecedor inválidos' });
    const db = getSqliteDatabase();
    const before = db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM iptv_providers WHERE id = ?`).get(id) as
      { name: string; hosts: string; notes: string | null; active: number } | undefined;
    if (!before) return reply.status(404).send({ error: 'Fornecedor não encontrado' });
    // Parcial: o que não vem fica como está.
    const hosts = parsed.data.hosts === undefined ? { hosts: before.hosts } : parseHosts(parsed.data.hosts);
    if ('error' in hosts) return reply.status(400).send({ error: hosts.error });
    const next = {
      name: parsed.data.name ?? before.name,
      notes: parsed.data.notes === undefined ? before.notes : parsed.data.notes,
      active: parsed.data.active === undefined ? before.active : parsed.data.active ? 1 : 0
    };
    const after = db.transaction(() => {
      db.prepare("UPDATE iptv_providers SET name = ?, hosts = ?, notes = ?, active = ?, updated_at = datetime('now') WHERE id = ?")
        .run(next.name, hosts.hosts, next.notes, next.active, id);
      const provider = db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM iptv_providers WHERE id = ?`).get(id);
      recordAuditStrict(db, request, {
        action: 'iptv_provider_update', entityType: 'iptv_provider', entityId: id,
        summary: `Alterou o fornecedor de IPTV ${next.name}`, metadata: { before, after: provider }
      });
      return provider;
    })();
    requestNetworkSync();
    return after;
  });

  // Não lê o router: os alvos vêm da base e o resultado do que o router fez, do registo das passagens.
  app.get('/api/iptv/status', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    const row = db.prepare("SELECT summary_json AS summary FROM job_runs WHERE job IN ('network_enforcement', 'network_enforcement_manual') AND summary_json IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { summary: string | null } | undefined;
    let last: unknown = null;
    try { last = row?.summary ? (JSON.parse(row.summary) as { iptv?: unknown }).iptv ?? null : null; } catch { /* resumo ilegível: sem corrida */ }
    return { targets: loadIptvTargets(db), last };
  });

  app.get('/api/iptv/validate', operators, async (_request, reply) => {
    const db = getSqliteDatabase();
    const targets = loadIptvTargets(db);
    const antennas = loadAntennaMacs(db, targets.map((t) => t.serviceId));
    const lans = db.prepare('SELECT id, service_id AS serviceId, lan_cidr AS lanCidr FROM service_device_assignments WHERE end_date IS NULL AND lan_cidr IS NOT NULL')
      .all() as Array<{ id: number; serviceId: number; lanCidr: string }>;
    const seen = await withRouter(reply, async (transport) => ({
      leases: await listDhcpLeases(transport), arp: await listArp(transport),
      sessions: await listActive(transport), addresses: await listIpAddresses(transport)
    }));
    if (!seen) return reply;
    const addresses = seen.addresses.filter((a) => !a.disabled).map((a) => a.address);
    return {
      services: targets.map((t) => ({
        serviceId: t.serviceId,
        validation: validateIptvSource(t.source, { antennaMac: antennas.get(t.serviceId) ?? null, leases: seen.leases, arp: seen.arp, sessions: seen.sessions })
      })),
      lanCollisions: lans.flatMap((l) => {
        const collidesWith = cidrOverlaps(l.lanCidr, addresses);
        return collidesWith ? [{ assignmentId: l.id, serviceId: l.serviceId, lanCidr: l.lanCidr, collidesWith }] : [];
      })
    };
  });

  app.get('/api/iptv/infra', adminOnly, async (_request, reply) => {
    const config = readIptvConfig(getSqliteDatabase());
    const reads = await withRouter(reply, readIptvInfra);
    return reads ? evaluateIptvInfra(config, reads) : reply;
  });

  // Os túneis que o router tem, com o nome que lá têm: só para informar. A VPN configura-se no router.
  app.get('/api/iptv/tunnels', adminOnly, async (_request, reply) => {
    const config = readIptvConfig(getSqliteDatabase());
    const reads = await withRouter(reply, readIptvInfra);
    return reads ? { tunnels: listIptvTunnels(config, reads) } : reply;
  });
}

/** As leituras da infraestrutura da VPN, as mesmas para o /infra e o /tunnels. */
async function readIptvInfra(t: RouterTransport): Promise<IptvInfraReads> {
  return {
    interfaces: await readInterfaces(t), peers: await readWireguardPeers(t), routes: await readRoutes(t), mangle: await readMangle(t),
    filter: await readForwardFilter(t), nat: await readSrcnat(t), listMembers: await readInterfaceListMembers(t)
  };
}
