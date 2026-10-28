import { describe, expect, test } from 'vitest';
import { currentTunnel, evaluateIptvInfra, listIptvTunnels } from './iptv-health';

const config = { splitList: 'IPTV-SPLIT', serversList: 'IPTV-SERVERS' };
const off = 'false';
// Nomes inventados de propósito: o código não pode depender deles.
const healthy = {
  interfaces: [{ name: 'tun-a', type: 'wg', running: 'true', disabled: off }, { name: 'wan-x', type: 'ether', running: 'true', disabled: off }],
  peers: [{ interface: 'tun-a', 'last-handshake': '42s', disabled: off }],
  routes: [
    { 'routing-table': 'tabela-tv', 'dst-address': '0.0.0.0/0', gateway: 'tun-a', active: 'true', disabled: off, distance: '1' },
    { 'routing-table': 'tabela-tv', 'dst-address': '0.0.0.0/0', blackhole: 'true', distance: '250', disabled: off },
    { 'routing-table': 'main', 'dst-address': '0.0.0.0/0', gateway: '192.168.100.1', 'immediate-gw': '192.168.100.1%wan-x', active: 'true', disabled: off }
  ],
  mangle: [
    { action: 'mark-connection', 'new-connection-mark': 'marca-tv', 'src-address-list': 'IPTV-SPLIT', disabled: off },
    { action: 'mark-routing', 'connection-mark': 'marca-tv', 'new-routing-mark': 'tabela-tv', 'src-address-list': 'IPTV-SPLIT', passthrough: 'false', disabled: off },
    { action: 'mark-connection', 'new-connection-mark': 'WAN1_conn', disabled: off }
  ],
  filter: [{ action: 'accept', 'src-address-list': 'IPTV-SPLIT', 'out-interface': 'tun-a', disabled: off }],
  nat: [{ action: 'masquerade', 'out-interface-list': 'TUNEIS', disabled: off }],
  listMembers: [{ list: 'TUNEIS', interface: 'tun-a', disabled: off }]
};
const find = (checks: ReturnType<typeof evaluateIptvInfra>, key: string) => checks.find((c) => c.key === key);

describe('evaluateIptvInfra', () => {
  test('descobre túnel, tabela e marca a partir da lista de origens', () => {
    const checks = evaluateIptvInfra(config, healthy);
    expect(checks.every((check) => check.state === 'ok')).toBe(true);
    expect(find(checks, 'tunnel')?.detail).toContain('tun-a');
  });
  test('trocar de VPN é só no router: outro túnel, de outro tipo, sem mudar nada no ISPM', () => {
    const swapped = {
      ...healthy,
      interfaces: [{ name: 'ovpn-b', type: 'ovpn-out', running: 'true', disabled: off }],
      peers: [],
      routes: healthy.routes.map((r) => (r.gateway === 'tun-a' ? { ...r, gateway: 'ovpn-b' } : r)),
      filter: [{ ...healthy.filter[0], 'out-interface': 'ovpn-b' }],
      listMembers: [{ list: 'TUNEIS', interface: 'ovpn-b', disabled: off }]
    };
    expect(evaluateIptvInfra(config, swapped).every((check) => check.state === 'ok')).toBe(true);
  });
  test('dois túneis em recurso: basta um vivo com a rota activa', () => {
    const failover = {
      ...healthy,
      interfaces: [...healthy.interfaces, { name: 'tun-b', type: 'wg', running: 'true', disabled: off }],
      peers: [...healthy.peers, { interface: 'tun-b', 'last-handshake': '10m', disabled: off }],
      routes: [...healthy.routes, { 'routing-table': 'tabela-tv', 'dst-address': '0.0.0.0/0', gateway: 'tun-b', active: 'false', disabled: off, distance: '2' }]
    };
    expect(find(evaluateIptvInfra(config, failover), 'tunnel')?.state).toBe('ok');
  });
  test('WireGuard com handshake velho conta como parado', () => {
    const stale = { ...healthy, peers: [{ ...healthy.peers[0], 'last-handshake': '3m1s' }] };
    expect(find(evaluateIptvInfra(config, stale), 'tunnel')?.state).toBe('stale');
  });
  test('sem regra de encaminhamento da lista não há como descobrir o túnel', () => {
    const none = { ...healthy, mangle: healthy.mangle.filter((r) => r.action !== 'mark-routing') };
    expect(find(evaluateIptvInfra(config, none), 'routing')?.state).toBe('missing');
    expect(find(evaluateIptvInfra(config, none), 'tunnel')?.state).toBe('missing');
  });
  test('uma WAN nova com regras acima da do IPTV é apanhada pela ordem, seja qual for a WAN', () => {
    const above = { ...healthy, mangle: [{ action: 'mark-routing', 'new-routing-mark': 'to_WAN3', passthrough: 'false', disabled: off }, ...healthy.mangle] };
    expect(find(evaluateIptvInfra(config, above), 'order')?.state).toBe('misordered');
  });
  test('NAT desactivado e filtro em falta', () => {
    const broken = { ...healthy, nat: [{ ...healthy.nat[0], disabled: 'true' }], filter: [] };
    const checks = evaluateIptvInfra(config, broken);
    expect(find(checks, 'nat')?.state).toBe('disabled');
    expect(find(checks, 'filter')?.state).toBe('missing');
  });
  test('split cujo encaminhamento só traz a marca de ligação, sem lista de origens', () => {
    const mangle = healthy.mangle.map((r) => {
      if (r.action !== 'mark-routing') return r;
      const { 'src-address-list': _omit, ...rest } = r;
      return rest;
    });
    expect(evaluateIptvInfra(config, { ...healthy, mangle }).every((check) => check.state === 'ok')).toBe(true);
  });
  test('rota inactiva com %interface no gateway e túnel em baixo: stale, não missing', () => {
    const down = {
      ...healthy,
      interfaces: [{ name: 'tun-a', type: 'ovpn-out', running: 'false', disabled: off }],
      routes: [{ 'routing-table': 'tabela-tv', 'dst-address': '0.0.0.0/0', gateway: '10.0.0.1%tun-a', active: 'false', disabled: off, distance: '1' }, healthy.routes[1]]
    };
    const checks = evaluateIptvInfra(config, down);
    expect(find(checks, 'tunnel')?.state).toBe('stale');
    expect(find(checks, 'filter')?.state).toBe('ok');
    expect(find(checks, 'nat')?.state).toBe('ok');
  });
  test('regra da lista desactivada no topo não conta para a ordem', () => {
    const pcc = { action: 'mark-routing', 'new-routing-mark': 'to_WAN3', passthrough: 'false', disabled: off };
    const off1 = { ...healthy.mangle[0], disabled: 'true' };
    expect(find(evaluateIptvInfra(config, { ...healthy, mangle: [off1, pcc, ...healthy.mangle] }), 'order')?.state).toBe('misordered');
  });
  test('o handshake mais recente entre os peers activos é o que conta', () => {
    const two = { ...healthy, peers: [{ interface: 'tun-a', 'last-handshake': '10m', disabled: off }, { interface: 'tun-a', 'last-handshake': '5s300ms', disabled: off }] };
    expect(find(evaluateIptvInfra(config, two), 'tunnel')?.state).toBe('ok');
  });

  test('uma blackhole de outra gama não protege a saída por omissão', () => {
    const routes = healthy.routes.map((route) => route.blackhole ? { ...route, 'dst-address': '192.0.2.0/24' } : route);
    expect(find(evaluateIptvInfra(config, { ...healthy, routes }), 'killswitch')?.state).toBe('missing');
  });

  // Medido no CHR 7.24.2: a REST marca a rota blackhole com a chave presente e vazia.
  test('blackhole como a REST a devolve ("blackhole": "") conta como rota de recurso', () => {
    const routes = healthy.routes.map((route) => route.blackhole ? { ...route, blackhole: '' } : route);
    const checks = evaluateIptvInfra(config, { ...healthy, routes });
    expect(find(checks, 'killswitch')?.state).toBe('ok');
    expect(find(checks, 'tunnel')?.state).toBe('ok');
  });

  test('uma blackhole por omissão desactivada não protege o tráfego', () => {
    const routes = healthy.routes.map((route) => route.blackhole ? { ...route, disabled: 'true' } : route);
    expect(find(evaluateIptvInfra(config, { ...healthy, routes }), 'killswitch')?.state).toBe('disabled');
  });

  test('uma rota específica pelo túnel não prova uma saída VPN por omissão', () => {
    const routes = healthy.routes.map((route) => route.gateway === 'tun-a' ? { ...route, 'dst-address': '192.0.2.0/24' } : route);
    expect(find(evaluateIptvInfra(config, { ...healthy, routes }), 'tunnel')?.state).toBe('missing');
  });

  test.each(['ether', 'bridge', 'vlan', 'bonding', 'pppoe-out', 'pppoe-in', 'unknown'])('%s não é uma interface VPN reconhecida', (type) => {
    const reads = { ...healthy, interfaces: [{ name: 'tun-a', type, running: 'true', disabled: off }] };
    const checks = evaluateIptvInfra(config, reads);
    expect(find(checks, 'tunnel')?.state).toBe('missing');
    expect(find(checks, 'filter')?.state).toBe('missing');
    expect(find(checks, 'nat')?.state).toBe('missing');
  });

  // Os `type` que o /interface do RouterOS 7.24.2 devolve, medidos no CHR (o GRE é `gre-tunnel`, não `gre`).
  test.each(['ovpn-out', 'l2tp-out', 'sstp-out', 'pptp-out', 'ipip-tunnel', 'ipipv6-tunnel', 'gre-tunnel', 'gre6-tunnel', 'eoip', 'eoipv6-', 'vxlan'])('%s activo é descoberto sem depender do fornecedor', (type) => {
    const reads = { ...healthy, interfaces: [{ name: 'tun-a', type, running: 'true', disabled: off }], peers: [] };
    expect(find(evaluateIptvInfra(config, reads), 'tunnel')?.state).toBe('ok');
  });

  test('entre duas rotas activas basta uma com túnel vivo, e aponta a degradada', () => {
    const reads = {
      ...healthy,
      interfaces: [...healthy.interfaces, { name: 'tun-b', type: 'ovpn-out', running: 'true', disabled: off }],
      peers: [{ interface: 'tun-a', 'last-handshake': '10m', disabled: off }],
      routes: [...healthy.routes, { 'routing-table': 'tabela-tv', 'dst-address': '0.0.0.0/0', gateway: 'tun-b', active: 'true', disabled: off, distance: '1' }]
    };
    const tunnel = find(evaluateIptvInfra(config, reads), 'tunnel');
    expect(tunnel?.state).toBe('ok');
    expect(tunnel?.detail).toContain('tun-b');
    expect(tunnel?.detail).toContain('tun-a');
  });
});

describe('túneis do router, só para informar', () => {
  // Um segundo túnel, de outro tipo, com rota de recurso; a blackhole fica de fora de tudo.
  const two = {
    ...healthy,
    interfaces: [...healthy.interfaces, { name: 'tun-b', type: 'ovpn-out', running: 'true', disabled: off }, { name: 'tun-c', type: 'wg', running: 'true', disabled: off }],
    routes: [{ '.id': '*1', ...healthy.routes[0] }, { '.id': '*2', ...healthy.routes[1] }, healthy.routes[2],
      { '.id': '*3', 'routing-table': 'tabela-tv', 'dst-address': '0.0.0.0/0', gateway: 'tun-b', active: 'false', disabled: off, distance: '5' }],
    listMembers: [...healthy.listMembers, { list: 'TUNEIS', interface: 'tun-b', disabled: off }],
    filter: [...healthy.filter, { action: 'accept', 'src-address-list': 'IPTV-SPLIT', 'out-interface-list': 'TUNEIS', disabled: off }]
  };
  const byName = (name: string) => listIptvTunnels(config, two).find((t) => t.name === name);

  test('lista só os túneis, com o que está em uso e o que está pronto', () => {
    expect(listIptvTunnels(config, two).map((t) => t.name)).toEqual(['tun-a', 'tun-b', 'tun-c']);
    expect(byName('tun-a')).toMatchObject({ type: 'wg', inUse: true, ready: true, reasons: [] });
    expect(byName('tun-b')).toMatchObject({ type: 'ovpn-out', inUse: false, ready: true });
  });
  test('sem NAT nem filtro pelo túnel, ou WireGuard sem handshake, não está pronto e diz porquê', () => {
    expect(byName('tun-c')).toMatchObject({ ready: false });
    expect(byName('tun-c')?.reasons).toEqual(expect.arrayContaining(['Sem NAT pelo túnel', 'Sem filtro de saída da lista pelo túnel']));
    expect(byName('tun-c')?.reasons.some((r) => r.includes('handshake'))).toBe(true);
  });
  test('desligado não está pronto', () => {
    const down = { ...two, interfaces: two.interfaces.map((i) => (i.name === 'tun-b' ? { ...i, running: 'false' } : i)) };
    expect(listIptvTunnels(config, down).find((t) => t.name === 'tun-b')).toMatchObject({ ready: false, reasons: ['tun-b: desligado'] });
  });
  test('o túnel em uso é o da rota por omissão da tabela, sem blackhole, de menor distance', () => {
    expect(currentTunnel(config, two)).toBe('tun-a');
    const swapped = { ...two, routes: two.routes.map((r: Record<string, unknown>) => (r.gateway === 'tun-a' ? { ...r, distance: '9' } : r)) };
    expect(currentTunnel(config, swapped)).toBe('tun-b');
  });
  test('sem regra de encaminhamento da lista não há túnel em uso', () => {
    expect(currentTunnel(config, { ...two, mangle: [] })).toBeNull();
  });
});
