import { isIPv4 } from 'node:net';
import type Database from 'better-sqlite3';
import { recordSystemAuditEntry } from './audit';
import { ANTENNA_TYPES, iptvSource, type IptvDevice, type IptvSource } from './iptv-source';
import { IPTV_SCRIPT_NAME, iptvScriptMark, iptvSplitScript } from './routeros-iptv-script';
import {
  addAddressListEntry, ensureRouterScript, listActive, listAddressList, listDhcpLeases, patchAddressListEntry, removeAddressListEntry, type RouterTransport
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
      unownedManual: Array<{ address: string; comment: string | null }>;
      foreignManual: Array<{ address: string; comment: string | null; holder: string }>;
      serversCovered: Array<{ address: string; comment: string | null; disabled: boolean }>;
      before: { mark: string; users: string[]; macs: string[] } | null;
      servers: { added: number; removed: number; renamed: number; reactivated: number } };

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

/** Equipamento activo de um serviço (próprio ou partilhado), a consulta única de quem decide a origem. */
const activeDevicesQuery = (db: Database.Database) => db.prepare(`
  SELECT e.type AS type, a.operation_mode AS operationMode, a.mac_address AS macAddress
  FROM assignment_services s
  JOIN service_device_assignments a ON a.id = s.assignment_id AND a.end_date IS NULL
  JOIN equipment_catalog e ON e.id = a.catalog_id
  WHERE s.service_id = ? ORDER BY a.id
`);

/** O MAC da antena (cpe/antena) activa do serviço, para a validação do WDS. */
export function loadAntennaMacs(db: Database.Database, serviceIds: number[]): Map<number, string | null> {
  const devices = activeDevicesQuery(db);
  return new Map(serviceIds.map((id) => {
    const antenna = (devices.all(id) as IptvDevice[]).find((d) => ANTENNA_TYPES.has((d.type ?? '').trim().toLowerCase()));
    return [id, antenna?.macAddress ?? null];
  }));
}

/** Serviços activos com a marca, e o identificador que o script segue para cada um. */
export function loadIptvTargets(db: Database.Database): IptvTarget[] {
  const services = db.prepare(`
    SELECT s.id, s.pppoe_username AS pppoeUsername, n.divergence
    FROM services s LEFT JOIN service_network_state n ON n.service_id = s.id
    WHERE s.iptv_vpn = 1 AND s.status = 'active' ORDER BY s.id
  `).all() as Array<{ id: number; pppoeUsername: string | null; divergence: string | null }>;
  const devices = activeDevicesQuery(db);
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
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

/**
 * A forma em que o RouterOS guarda o endereço: IPv4 sem `/32`, prefixo com os bits de host a
 * zero, domínio em minúsculas. `null` para o que não é domínio nem IPv4 (com `/0`–`/32`).
 */
export function canonicalHost(value: string): string | null {
  const [ip, prefix, ...rest] = value.split('/');
  if (isIPv4(ip)) {
    if (rest.length > 0) return null;
    if (prefix === undefined) return ip;
    if (!/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) return null;
    const bits = Number(prefix);
    if (bits === 32) return ip;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const n = ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
    const net = (n & mask) >>> 0;
    return `${[24, 16, 8, 0].map((shift) => (net >>> shift) & 255).join('.')}/${bits}`;
  }
  return !value.includes('/') && HOSTNAME.test(value) ? value.toLowerCase() : null;
}

/** Domínio ou IPv4 (com prefixo /0–/32 opcional). Octetos acima de 255 não passam. */
export const HOST = { test: (value: string): boolean => canonicalHost(value) !== null };

/** Um endereço só tem uma entrada na lista (o RouterOS recusa a segunda): o primeiro fornecedor, por id, fica com ela. */
function desiredServers(db: Database.Database): Array<{ address: string; comment: string }> {
  const rows = db.prepare('SELECT id, name, hosts FROM iptv_providers WHERE active = 1 ORDER BY id').all() as Array<{ id: number; name: string; hosts: string }>;
  const seen = new Set<string>();
  return rows.flatMap((row) => row.hosts.split(/\r?\n/).map((h) => h.trim()).flatMap((h) => canonicalHost(h) ?? [])
    .sort().filter((h) => !seen.has(h) && !!seen.add(h))
    .map((address) => ({ address, comment: serverComment(row.id, row.name) })));
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

  const all = await listAddressList(transport, config.serversList);
  const existing = all.filter((e) => e.comment?.startsWith(SERVER_PREFIX));
  // Compara-se sempre na forma canónica, dos dois lados: o router guarda `8.8.8.0/24`, não `8.8.8.8/24`.
  const canon = (address: string) => canonicalHost(address) ?? address.toLowerCase();
  const wantedByAddress = new Map(servers.map((s) => [s.address, s]));
  const ours = new Map<string, (typeof existing)[number]>();
  for (const e of existing) if (wantedByAddress.has(canon(e.address)) && !ours.has(canon(e.address))) ours.set(canon(e.address), e);
  const toRemove = existing.filter((e) => ours.get(canon(e.address)) !== e);
  // O RouterOS recusa um segundo `add` com a mesma lista e endereço: um endereço que uma
  // entrada de outra origem (manual) já cobre não se acrescenta, só se reporta.
  const foreign = new Map(all.filter((e) => !e.comment?.startsWith(SERVER_PREFIX)).map((e) => [canon(e.address), e]));
  const serversCovered = servers.filter((s) => foreign.has(s.address)).map((s) => ({ address: s.address, comment: foreign.get(s.address)!.comment, disabled: foreign.get(s.address)!.disabled }));
  // Uma entrada do ISPM com o endereço certo mas outro comentário (fornecedor renomeado, ou
  // host que mudou de fornecedor) muda de comentário no mesmo .id: nunca há janela sem entrada.
  const toUpdate = servers.flatMap((s) => {
    const entry = ours.get(s.address);
    if (!entry || foreign.has(s.address)) return [];
    const renamed = entry.comment !== s.comment;
    if (!renamed && !entry.disabled) return [];
    return [{ id: entry.id, address: s.address, renamed, reactivated: entry.disabled,
      fields: { ...(renamed ? { comment: s.comment } : {}), ...(entry.disabled ? { disabled: false } : {}) } }];
  });
  const toAdd = servers.filter((s) => !ours.has(s.address) && !foreign.has(s.address));
  // O que o router vê agora: por onde entra cada cliente marcado (PPPoE ou legacy) e o
  // estado das entradas manuais. Só leitura; o script não depende disto.
  const sessions = await listActive(transport);
  const allLeases = await listDhcpLeases(transport);
  const leases = allLeases.filter((l) => l.status === 'bound');
  const active = targets.map((t) => {
    const username = t.source.kind === 'pppoe' ? t.source.username : null;
    const mac = t.source.kind === 'mac' ? t.source.mac : t.source.kind === 'pppoe' ? t.source.legacy?.mac ?? null : null;
    const session = username ? sessions.find((s) => s.name === username) : undefined;
    if (session?.address) return { serviceId: t.serviceId, via: 'pppoe' as const, address: session.address };
    const lease = mac ? leases.find((l) => l.macAddress?.toUpperCase() === mac) : undefined;
    return lease ? { serviceId: t.serviceId, via: 'legacy' as const, address: lease.address } : { serviceId: t.serviceId, via: null };
  });
  // Entradas manuais: o ISPM nunca as apaga. "Em uso" = o endereço de um cliente marcado
  // (o script não o duplica, e é essa entrada que manda nele). "Alheia" = o endereço está
  // agora com outro MAC ou outra sessão: depois de um cliente migrar, o IP legacy pode ir
  // parar a outro cliente e dar-lhe IPTV pela VPN sem estar marcado. "Sem dono visível" =
  // nenhuma sessão nem lease (de qualquer estado: uma estática em `waiting` é um aparelho
  // desligado) com este endereço. É o operador que as remove no router.
  const manual = (await listAddressList(transport, config.splitList)).filter((e) => !e.comment?.startsWith('ispm-iptv:'));
  const live = new Set(active.flatMap((a) => (a.via ? [a.address] : [])));
  const taken = new Set([...sessions.map((s) => s.address), ...allLeases.map((l) => l.address)].filter(Boolean));
  const manualConflicts = manual.filter((e) => live.has(e.address)).map((e) => ({ address: e.address, comment: e.comment }));
  const unownedManual = manual.filter((e) => !taken.has(e.address) && /^\d+\.\d+\.\d+\.\d+$/.test(e.address))
    .map((e) => ({ address: e.address, comment: e.comment }));
  const targetMacs = new Set(macs);
  const targetUsers = new Set(users);
  const foreignManual = manual.flatMap((e) => {
    const lease = leases.find((l) => l.address === e.address && !targetMacs.has(l.macAddress?.toUpperCase() ?? ''));
    const session = sessions.find((x) => x.address === e.address && !targetUsers.has(x.name));
    const holder = lease?.macAddress?.toUpperCase() ?? session?.name;
    return holder ? [{ address: e.address, comment: e.comment, holder }] : [];
  });

  let before: { mark: string; users: string[]; macs: string[] } | null = null;
  try { before = previous ? JSON.parse(previous) : null; } catch { /* valor corrompido: conta como nunca aplicado */ }
  const summary = { users: [...new Set(users)].sort(), macs: [...new Set(macs)].sort(), missing, mark, active, manualConflicts, unownedManual, foreignManual, serversCovered, before,
    servers: { added: toAdd.length, removed: toRemove.length, renamed: toUpdate.filter((e) => e.renamed).length, reactivated: toUpdate.filter((e) => e.reactivated).length } };
  if (dryRun) return { status: 'dry_run', ...summary };

  // Acrescentar antes de retirar: a meio de uma falha, um fornecedor nunca fica sem entrada.
  // Auditado mesmo que uma escrita a meio falhe: regista o que chegou a ser escrito, e o erro propaga.
  const written = { added: [] as string[], removed: [] as string[], renamed: [] as string[], reactivated: [] as string[] };
  try {
    for (const entry of toAdd) {
      await addAddressListEntry(transport, { list: config.serversList, ...entry });
      written.added.push(entry.address);
    }
    for (const entry of toUpdate) {
      await patchAddressListEntry(transport, entry.id, entry.fields);
      if (entry.renamed) written.renamed.push(entry.address);
      if (entry.reactivated) written.reactivated.push(entry.address);
    }
    for (const entry of toRemove) {
      await removeAddressListEntry(transport, entry.id);
      written.removed.push(entry.address);
    }
  } finally {
    if (written.added.length || written.removed.length || written.renamed.length || written.reactivated.length) {
      recordSystemAuditEntry(db, {
        action: 'iptv_vpn_servers', entityType: 'router',
        summary: `IPTV via VPN: servidores +${written.added.length} -${written.removed.length} ~${written.renamed.length}, ${written.reactivated.length} reactivados`,
        metadata: written
      });
    }
  }
  await ensureRouterScript(transport, { name: IPTV_SCRIPT_NAME, comment: mark, source, interval: '1m' });
  if (before?.mark !== mark) {
    await transport({ method: 'POST', path: '/system/script/run', body: { '.id': IPTV_SCRIPT_NAME } });
  }
  const after = { mark, users: summary.users, macs: summary.macs };
  if (before?.mark !== mark) {
    recordSystemAuditEntry(db, {
      action: 'iptv_vpn_sync', entityType: 'router',
      summary: `IPTV via VPN: ${after.users.length} PPPoE, ${after.macs.length} legacy`,
      metadata: { before, after }
    });
  }
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(APPLIED_KEY, JSON.stringify(after));
  return { status: 'applied', ...summary };
}
