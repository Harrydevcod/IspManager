import type Database from 'better-sqlite3';
import { recordSystemAuditEntry } from './audit';
import { iptvSource, type IptvDevice, type IptvSource } from './iptv-source';
import { IPTV_SCRIPT_NAME, iptvScriptMark, iptvSplitScript } from './routeros-iptv-script';
import {
  addAddressListEntry, ensureRouterScript, listActive, listAddressList, listDhcpLeases, removeAddressListEntry, type RouterTransport
} from './routeros';

/** Só os nomes das listas. Túnel, tabela e marca descobrem-se no router (T7). */
export type IptvConfig = { splitList: string; serversList: string };
export type IptvTarget = { serviceId: number; source: IptvSource };
export type IptvActive = { serviceId: number; via: 'pppoe' | 'legacy'; address: string } | { serviceId: number; via: null };
export type IptvSyncResult =
  | { status: 'idle' }
  | { status: 'dry_run' | 'applied'; users: string[]; macs: string[]; missing: Array<{ serviceId: number; reason: string }>; mark: string;
      active: IptvActive[];
      manualConflicts: Array<{ address: string; comment: string | null }>;
      staleManual: Array<{ address: string; comment: string | null }>;
      before: { mark: string; users: string[]; macs: string[] } | null;
      servers: { added: number; removed: number } };

const SERVER_PREFIX = 'ispm-iptv-srv:';
const APPLIED_KEY = 'iptvVpnApplied';

const setting = (db: Database.Database, key: string, fallback: string) =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value?.trim() || fallback;

export function readIptvConfig(db: Database.Database): IptvConfig {
  return {
    splitList: setting(db, 'iptvVpnSplitList', 'IPTV-SPLIT'),
    serversList: setting(db, 'iptvVpnServersList', 'IPTV-SERVERS')
  };
}

const USERNAME = /^[\w.@-]{1,64}$/;

/** Serviços activos com a marca, e o identificador que o script segue para cada um. */
export function loadIptvTargets(db: Database.Database): IptvTarget[] {
  const services = db.prepare(`
    SELECT s.id, s.pppoe_username AS pppoeUsername, n.divergence
    FROM services s LEFT JOIN service_network_state n ON n.service_id = s.id
    WHERE s.iptv_vpn = 1 AND s.status = 'active' ORDER BY s.id
  `).all() as Array<{ id: number; pppoeUsername: string | null; divergence: string | null }>;
  const devices = db.prepare(`
    SELECT e.type AS type, a.operation_mode AS operationMode, a.mac_address AS macAddress
    FROM assignment_services s
    JOIN service_device_assignments a ON a.id = s.assignment_id AND a.end_date IS NULL
    JOIN equipment_catalog e ON e.id = a.catalog_id
    WHERE s.service_id = ? ORDER BY a.id
  `);
  return services.map((service) => {
    // Um nome mudado no Winbox é uma divergência do ADR 0014: não se adivinha qual vale.
    if (service.pppoeUsername && service.divergence?.includes('username')) {
      return { serviceId: service.id, source: { kind: 'missing', reason: 'Utilizador diferente no router: resolva na Reconciliação' } };
    }
    const source = iptvSource(service, devices.all(service.id) as IptvDevice[]);
    // Um utilizador que o gerador recusaria cai só neste serviço, não na passagem toda.
    if (source.kind === 'pppoe' && !USERNAME.test(source.username)) {
      return { serviceId: service.id, source: { kind: 'missing', reason: 'Utilizador PPPoE com caracteres inválidos' } };
    }
    return { serviceId: service.id, source };
  });
}

/** Comentário em ASCII, como o dos secrets: o RouterOS guarda-o tal e qual. */
const serverComment = (id: number, name: string) =>
  `${SERVER_PREFIX}${id} ${name.normalize('NFD').replace(/[^ -~]/g, '').replace(/\s+/g, ' ').trim()}`;
export const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|(?=.{1,253}$)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63})$/i;

function desiredServers(db: Database.Database): Array<{ address: string; comment: string }> {
  const rows = db.prepare('SELECT id, name, hosts FROM iptv_providers WHERE active = 1 ORDER BY id').all() as Array<{ id: number; name: string; hosts: string }>;
  return rows.flatMap((row) => row.hosts.split(/\r?\n/).map((h) => h.trim()).filter((h) => HOST.test(h))
    .map((h) => h.toLowerCase()).sort().map((address) => ({ address, comment: serverComment(row.id, row.name) })));
}

/**
 * Um passo da passagem do router (ADR 0021): o script com as origens e as entradas do ISPM
 * na lista de servidores. Em ensaio só lê. Sem nada marcado e nada instalado, não instala.
 */
export async function syncIptv(db: Database.Database, { transport, dryRun }: { transport: RouterTransport; dryRun: boolean }): Promise<IptvSyncResult> {
  const config = readIptvConfig(db);
  const targets = loadIptvTargets(db);
  const users = targets.flatMap((t) => (t.source.kind === 'pppoe' ? [t.source.username] : []));
  const macs = targets.flatMap((t) => (t.source.kind === 'mac' ? [t.source.mac] : t.source.kind === 'pppoe' && t.source.legacy ? [t.source.legacy.mac] : []));
  const missing = targets.flatMap((t) => (t.source.kind === 'missing' ? [{ serviceId: t.serviceId, reason: t.source.reason }] : []));
  const servers = desiredServers(db);
  const previous = setting(db, APPLIED_KEY, '');
  if (targets.length === 0 && servers.length === 0 && !previous) return { status: 'idle' };

  const source = iptvSplitScript({ list: config.splitList, users, macs });
  const mark = iptvScriptMark(source);

  const existing = (await listAddressList(transport, config.serversList)).filter((e) => e.comment?.startsWith(SERVER_PREFIX));
  const key = (e: { address: string; comment: string | null }) => `${e.comment}|${e.address.toLowerCase()}`;
  const wanted = new Set(servers.map(key));
  const have = new Set(existing.map(key));
  const toAdd = servers.filter((s) => !have.has(key(s)));
  const toRemove = existing.filter((e) => !wanted.has(key(e)));
  // O que o router vê agora: por onde entra cada cliente marcado (PPPoE ou legacy) e o
  // estado das entradas manuais. Só leitura; o script não depende disto.
  const sessions = await listActive(transport);
  const leases = (await listDhcpLeases(transport)).filter((l) => l.status === 'bound');
  const active = targets.map((t) => {
    const username = t.source.kind === 'pppoe' ? t.source.username : null;
    const mac = t.source.kind === 'mac' ? t.source.mac : t.source.kind === 'pppoe' ? t.source.legacy?.mac ?? null : null;
    const session = username ? sessions.find((s) => s.name === username) : undefined;
    if (session?.address) return { serviceId: t.serviceId, via: 'pppoe' as const, address: session.address };
    const lease = mac ? leases.find((l) => l.macAddress?.toUpperCase() === mac) : undefined;
    return lease ? { serviceId: t.serviceId, via: 'legacy' as const, address: lease.address } : { serviceId: t.serviceId, via: null };
  });
  // Entradas manuais: o ISPM nunca as apaga. "Em uso" = o endereço de um cliente marcado
  // (o script não o duplica, e é essa entrada que manda nele). "Obsoleta" = endereço que já
  // ninguém tem: depois de um cliente migrar para PPPoE, o IP legacy pode ir parar a outro
  // cliente e dar-lhe IPTV pela VPN por engano. É o operador que a remove no router.
  const manual = (await listAddressList(transport, config.splitList)).filter((e) => !e.comment?.startsWith('ispm-iptv:'));
  const live = new Set(active.flatMap((a) => (a.via ? [a.address] : [])));
  const taken = new Set([...sessions.map((s) => s.address), ...leases.map((l) => l.address)].filter(Boolean));
  const manualConflicts = manual.filter((e) => live.has(e.address)).map((e) => ({ address: e.address, comment: e.comment }));
  const staleManual = manual.filter((e) => !taken.has(e.address) && /^\d+\.\d+\.\d+\.\d+$/.test(e.address))
    .map((e) => ({ address: e.address, comment: e.comment }));

  const before = previous ? JSON.parse(previous) as { mark: string; users: string[]; macs: string[] } : null;
  const summary = { users: [...new Set(users)].sort(), macs: [...new Set(macs)].sort(), missing, mark, active, manualConflicts, staleManual, before,
    servers: { added: toAdd.length, removed: toRemove.length } };
  if (dryRun) return { status: 'dry_run', ...summary };

  // Acrescentar antes de retirar: a meio de uma falha, um fornecedor nunca fica sem entrada.
  for (const entry of toAdd) await addAddressListEntry(transport, { list: config.serversList, ...entry });
  for (const entry of toRemove) await removeAddressListEntry(transport, entry.id);
  await ensureRouterScript(transport, { name: IPTV_SCRIPT_NAME, comment: mark, source, interval: '1m' });
  if (JSON.parse(previous || '{}').mark !== mark) {
    await transport({ method: 'POST', path: '/system/script/run', body: { '.id': IPTV_SCRIPT_NAME } });
  }
  const after = { mark, users: summary.users, macs: summary.macs };
  if (before?.mark !== mark || toAdd.length || toRemove.length) {
    recordSystemAuditEntry(db, {
      action: 'iptv_vpn_sync', entityType: 'router',
      summary: `IPTV via VPN: ${after.users.length} PPPoE, ${after.macs.length} legacy`,
      metadata: { before, after, servers: summary.servers }
    });
  }
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(APPLIED_KEY, JSON.stringify(after));
  return { status: 'applied', ...summary };
}
