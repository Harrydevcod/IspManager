import { uptimeSeconds } from '../../shared/duration';
import type { IptvConfig } from './iptv';

type Row = Record<string, unknown>;
type CheckState = 'ok' | 'missing' | 'disabled' | 'stale' | 'misordered';
export type IptvCheck = { key: 'routing' | 'mark' | 'order' | 'tunnel' | 'killswitch' | 'filter' | 'nat'; label: string; state: CheckState; detail?: string };
/** `mangle` já vem só com a chain prerouting, pela ordem do router (`readMangle`). */
export type IptvInfraReads = { interfaces: Row[]; peers: Row[]; routes: Row[]; mangle: Row[]; filter: Row[]; nat: Row[]; listMembers: Row[] };

const yes = (value: unknown) => value === true || value === 'true' || value === 'yes';
const on = (row: Row) => !yes(row.disabled);
const HANDSHAKE_LIMIT_S = 180;
// Tipos de túnel como o /interface do RouterOS os devolve, medidos no CHR 7.24.2: o GRE é
// `gre-tunnel` e o IPIP `ipip-tunnel` (não `gre`/`ipip`), e o EoIPv6 vem truncado em `eoipv6-`.
// Uma interface física, bridge ou PPPoE não prova uma VPN; um tipo novo mede-se antes de entrar.
const TUNNEL_TYPES = new Set([
  'wg', 'ovpn-out', 'ovpn-in', 'l2tp-out', 'l2tp-in', 'sstp-out', 'sstp-in', 'pptp-out', 'pptp-in',
  'ipip-tunnel', 'ipipv6-tunnel', 'gre-tunnel', 'gre6-tunnel', 'eoip', 'eoipv6-', 'l2tp-ether', 'vxlan'
]);
const isDefault = (route: Row) => route['dst-address'] === '0.0.0.0/0';
// A REST do 7.24 marca a blackhole com a chave presente e vazia (`"blackhole": ""`, medido no CHR);
// uma rota normal nem traz a chave.
const isBlackhole = (route: Row) => 'blackhole' in route && route.blackhole !== 'false' && route.blackhole !== false;

function state(rows: Row[]): CheckState {
  return rows.length === 0 ? 'missing' : rows.some(on) ? 'ok' : 'disabled';
}

/** A interface de saída de uma rota: o próprio gateway, ou o que vem depois de `%` em `immediate-gw`. */
const routeInterface = (route: Row, names: Set<string>) => {
  const candidates = [String(route.gateway ?? ''), String(route['immediate-gw'] ?? '')];
  for (const value of candidates) {
    const name = value.includes('%') ? value.slice(value.lastIndexOf('%') + 1) : value;
    if (names.has(name)) return name;
  }
  return null;
};

/** Um túnel está vivo se a interface corre; num WireGuard, também com handshake recente. */
function tunnelAlive(name: string, reads: IptvInfraReads): { alive: boolean; detail: string } {
  const iface = reads.interfaces.find((row) => row.name === name);
  if (!iface || !on(iface) || !yes(iface.running)) return { alive: false, detail: `${name}: desligado` };
  if (iface.type !== 'wg') return { alive: true, detail: `${name} (${String(iface.type)}): a correr` };
  // Vários peers: conta o handshake mais recente.
  const ages = reads.peers.filter((row) => row.interface === name && on(row)).flatMap((row) => {
    const text = typeof row['last-handshake'] === 'string' ? row['last-handshake'] : null;
    const seconds = uptimeSeconds(text);
    return seconds === null ? [] : [{ seconds, text }];
  });
  const latest = ages.sort((a, b) => a.seconds - b.seconds)[0];
  return latest && latest.seconds <= HANDSHAKE_LIMIT_S
    ? { alive: true, detail: `${name}: último handshake há ${latest.text}` }
    : { alive: false, detail: `${name}: sem handshake há mais de 3 minutos` };
}

/**
 * O que tem de existir no router para o IPTV ir pela VPN (ADR 0021). Nada vem das
 * Definições além do nome da lista de origens: a regra de mangle que encaminha essa
 * lista diz a tabela; as rotas dessa tabela dizem os túneis, de qualquer tipo e quantos
 * houver (recurso); o filtro e o NAT procuram-se por esses túneis, directamente ou por
 * interface-list. As WAN nunca se lêem: a única coisa que se verifica é que nenhuma regra
 * de balanceamento, de nenhuma WAN, vem antes da do IPTV. Trocar de VPN ou de WAN é só
 * no router.
 */
/** A tabela do IPTV, pela regra de mangle que encaminha a lista de origens (ou a marca que ela pôs). */
function discoverTable(config: IptvConfig, prerouting: Row[]) {
  const ofList = (row: Row) => row['src-address-list'] === config.splitList;
  const marking = prerouting.filter((r) => r.action === 'mark-connection' && ofList(r));
  // O encaminhamento da lista: ou traz a lista, ou segue a marca de ligação que a lista pôs.
  const marks = new Set(marking.filter(on).map((r) => String(r['new-connection-mark'] ?? '')).filter(Boolean));
  const ofSplit = (r: Row) => ofList(r) || marks.has(String(r['connection-mark'] ?? ''));
  const routing = prerouting.filter((r) => r.action === 'mark-routing' && ofSplit(r));
  return { ofList, ofSplit, marking, routing, table: String(routing.find(on)?.['new-routing-mark'] ?? '') };
}

const tunnelNames = (reads: IptvInfraReads) => new Set(reads.interfaces.filter((row) => TUNNEL_TYPES.has(String(row.type))).map((row) => String(row.name)));

/** Sai por estes túneis: directamente ou por uma interface-list a que pertencem. */
function outThrough(tunnels: string[], reads: IptvInfraReads) {
  const lists = new Set(reads.listMembers.filter((m) => on(m) && tunnels.includes(String(m.interface))).map((m) => String(m.list)));
  return (r: Row) => tunnels.includes(String(r['out-interface'] ?? '')) || lists.has(String(r['out-interface-list'] ?? ''));
}

const coveredBy = (config: IptvConfig, reads: IptvInfraReads, tunnels: string[]) => {
  const out = outThrough(tunnels, reads);
  return {
    filter: reads.filter.filter((r) => r.action === 'accept' && r['src-address-list'] === config.splitList && out(r)),
    nat: reads.nat.filter((r) => (r.action === 'masquerade' || r.action === 'src-nat') && out(r))
  };
};

/** O túnel por onde sai o IPTV: o da rota por omissão da tabela do IPTV, sem blackhole, ligada, de menor distance. */
export function currentTunnel(config: IptvConfig, reads: IptvInfraReads): string | null {
  const { table } = discoverTable(config, reads.mangle);
  if (!table) return null;
  const route = reads.routes
    .filter((r) => r['routing-table'] === table && isDefault(r) && !isBlackhole(r) && on(r))
    .sort((a, b) => (Number(a.distance ?? 1) || 1) - (Number(b.distance ?? 1) || 1))[0];
  return route ? routeInterface(route, tunnelNames(reads)) : null;
}

export type IptvTunnel = { name: string; type: string; alive: boolean; detail: string; inUse: boolean; ready: boolean; reasons: string[] };

/**
 * Os túneis que o router tem, com o nome que lá têm, e o que falta a cada um para levar o
 * IPTV. Só informa: a VPN, de qualquer fornecedor, configura-se no router (ADR 0021).
 */
export function listIptvTunnels(config: IptvConfig, reads: IptvInfraReads): IptvTunnel[] {
  const names = tunnelNames(reads);
  const current = currentTunnel(config, reads);
  return reads.interfaces.filter((row) => names.has(String(row.name))).map((row) => {
    const name = String(row.name);
    const status = tunnelAlive(name, reads);
    const covered = coveredBy(config, reads, [name]);
    const reasons = [
      ...(status.alive ? [] : [status.detail]),
      ...(covered.nat.some(on) ? [] : ['Sem NAT pelo túnel']),
      ...(covered.filter.some(on) ? [] : ['Sem filtro de saída da lista pelo túnel'])
    ];
    return { name, type: String(row.type), alive: status.alive, detail: status.detail, inUse: name === current, ready: reasons.length === 0, reasons };
  });
}

export function evaluateIptvInfra(config: IptvConfig, reads: IptvInfraReads): IptvCheck[] {
  const prerouting = reads.mangle;
  const { ofList, ofSplit, marking, routing, table } = discoverTable(config, prerouting);

  // Ordem: a primeira regra da lista tem de vir antes de qualquer outra marcação, e a de
  // encaminhamento tem de parar ali (passthrough=no), para nenhum balanceamento a desfazer.
  const first = prerouting.findIndex((r) => on(r) && (ofList(r) || (r.action === 'mark-routing' && ofSplit(r))));
  const before = first < 0 ? [] : prerouting.slice(0, first).filter((r) => on(r) && (r.action === 'mark-connection' || r.action === 'mark-routing'));
  const passes = routing.some((r) => on(r) && !(r.passthrough === 'false' || r.passthrough === false || r.passthrough === 'no'));
  const order: IptvCheck = first < 0 ? { key: 'order', label: 'Ordem das regras', state: 'missing' }
    : before.length || passes ? { key: 'order', label: 'Ordem das regras', state: 'misordered',
      detail: before.length ? `${before.length} regra(s) de marcação antes da do IPTV` : 'O encaminhamento do IPTV deixa passar para as regras seguintes' }
    : { key: 'order', label: 'Ordem das regras', state: 'ok' };

  const names = tunnelNames(reads);
  const tableRoutes = reads.routes.filter((r) => table && r['routing-table'] === table);
  const tunnelRoutes = tableRoutes.filter((r) => isDefault(r) && !isBlackhole(r) && on(r));
  const tunnels = [...new Set(tunnelRoutes.map((r) => routeInterface(r, names)).filter((n): n is string => Boolean(n)))];
  const activeTunnels = [...new Set(tunnelRoutes.filter((r) => yes(r.active)).map((r) => routeInterface(r, names)).filter((n): n is string => Boolean(n)))];
  const statuses = activeTunnels.map((name) => tunnelAlive(name, reads));
  const status = statuses.find((s) => s.alive) ?? statuses[0];
  const degraded = statuses.filter((s) => !s.alive).map((s) => s.detail);
  const tunnel: IptvCheck = !table || tunnels.length === 0
    ? { key: 'tunnel', label: 'Túnel VPN', state: 'missing', detail: table ? `Sem rota por omissão da tabela ${table} por um túnel reconhecido` : 'Sem regra de encaminhamento da lista' }
    : !status ? { key: 'tunnel', label: 'Túnel VPN', state: 'stale', detail: `Nenhuma rota da tabela ${table} activa` }
    : { key: 'tunnel', label: 'Túnel VPN', state: status.alive ? 'ok' : 'stale',
      detail: status.alive && degraded.length ? `${status.detail}; rota(s) degradada(s): ${degraded.join('; ')}` : status.detail };

  const covered = coveredBy(config, reads, tunnels);
  return [
    { key: 'routing', label: 'Encaminhamento da lista para a VPN', state: state(routing), detail: table ? `Tabela ${table}` : undefined },
    { key: 'mark', label: 'Marca das ligações IPTV', state: state(marking) },
    order,
    tunnel,
    { key: 'killswitch', label: 'Rota de recurso (blackhole)', state: state(tableRoutes.filter((r) => isDefault(r) && isBlackhole(r))) },
    { key: 'filter', label: 'Filtro de saída pelo túnel', state: state(covered.filter) },
    { key: 'nat', label: 'NAT do túnel', state: state(covered.nat) }
  ];
}
