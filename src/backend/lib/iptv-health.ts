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
export function evaluateIptvInfra(config: IptvConfig, reads: IptvInfraReads): IptvCheck[] {
  const prerouting = reads.mangle;
  const ofList = (row: Row) => row['src-address-list'] === config.splitList;
  const marking = prerouting.filter((r) => r.action === 'mark-connection' && ofList(r));
  // O encaminhamento da lista: ou traz a lista, ou segue a marca de ligação que a lista pôs.
  const marks = new Set(marking.filter(on).map((r) => String(r['new-connection-mark'] ?? '')).filter(Boolean));
  const ofSplit = (r: Row) => ofList(r) || marks.has(String(r['connection-mark'] ?? ''));
  const routing = prerouting.filter((r) => r.action === 'mark-routing' && ofSplit(r));
  const table = String(routing.find(on)?.['new-routing-mark'] ?? '');

  // Ordem: a primeira regra da lista tem de vir antes de qualquer outra marcação, e a de
  // encaminhamento tem de parar ali (passthrough=no), para nenhum balanceamento a desfazer.
  const first = prerouting.findIndex((r) => on(r) && (ofList(r) || (r.action === 'mark-routing' && ofSplit(r))));
  const before = first < 0 ? [] : prerouting.slice(0, first).filter((r) => on(r) && (r.action === 'mark-connection' || r.action === 'mark-routing'));
  const passes = routing.some((r) => on(r) && !(r.passthrough === 'false' || r.passthrough === false || r.passthrough === 'no'));
  const order: IptvCheck = first < 0 ? { key: 'order', label: 'Ordem das regras', state: 'missing' }
    : before.length || passes ? { key: 'order', label: 'Ordem das regras', state: 'misordered',
      detail: before.length ? `${before.length} regra(s) de marcação antes da do IPTV` : 'O encaminhamento do IPTV deixa passar para as regras seguintes' }
    : { key: 'order', label: 'Ordem das regras', state: 'ok' };

  const names = new Set(reads.interfaces.map((row) => String(row.name)));
  const tableRoutes = reads.routes.filter((r) => table && r['routing-table'] === table);
  const tunnelRoutes = tableRoutes.filter((r) => !yes(r.blackhole) && on(r));
  const tunnels = [...new Set(tunnelRoutes.map((r) => routeInterface(r, names)).filter((n): n is string => Boolean(n)))];
  const activeTunnel = tunnelRoutes.filter((r) => yes(r.active)).map((r) => routeInterface(r, names)).find(Boolean) ?? null;
  const status = activeTunnel ? tunnelAlive(activeTunnel, reads) : null;
  const tunnel: IptvCheck = !table || tunnels.length === 0
    ? { key: 'tunnel', label: 'Túnel VPN', state: 'missing', detail: table ? `Sem rota da tabela ${table} por um túnel` : 'Sem regra de encaminhamento da lista' }
    : !status ? { key: 'tunnel', label: 'Túnel VPN', state: 'stale', detail: `Nenhuma rota da tabela ${table} activa` }
    : { key: 'tunnel', label: 'Túnel VPN', state: status.alive ? 'ok' : 'stale', detail: status.detail };

  const lists = new Set(reads.listMembers.filter((m) => on(m) && tunnels.includes(String(m.interface))).map((m) => String(m.list)));
  const outTunnel = (r: Row) => tunnels.includes(String(r['out-interface'] ?? '')) || lists.has(String(r['out-interface-list'] ?? ''));
  return [
    { key: 'routing', label: 'Encaminhamento da lista para a VPN', state: state(routing), detail: table ? `Tabela ${table}` : undefined },
    { key: 'mark', label: 'Marca das ligações IPTV', state: state(marking) },
    order,
    tunnel,
    { key: 'killswitch', label: 'Rota de recurso (blackhole)', state: state(tableRoutes.filter((r) => yes(r.blackhole))) },
    { key: 'filter', label: 'Filtro de saída pelo túnel', state: state(reads.filter.filter((r) => r.action === 'accept' && ofList(r) && outTunnel(r))) },
    { key: 'nat', label: 'NAT do túnel', state: state(reads.nat.filter((r) => (r.action === 'masquerade' || r.action === 'src-nat') && outTunnel(r))) }
  ];
}
