import { describe, expect, test } from 'vitest';
import type { TopologyBackboneNode } from '../../shared/topology';
import { checkTopologyPorts, readTopologyLive } from './topology-live';
import type { RouterConfig, RouterRequest, RouterTransport } from './routeros';

const node = (id: number, parentIds: TopologyBackboneNode['parentIds'], macAddress: string | null, routerInterface: string | null = null) => ({
  id: `backbone:${id}` as const, backboneDeviceId: id, parentIds, macAddress, routerInterface
}) as TopologyBackboneNode;

describe('checkTopologyPorts', () => {
  const router = node(1, ['backbone:10', 'backbone:11'], null);
  const starlink = node(10, ['root:isp'], 'AA:BB:CC:00:00:10', 'WAN1-STARLINK');
  const switchNode = node(2, ['backbone:1'], 'AA:BB:CC:00:00:02', 'ether3');
  const antenna = node(3, ['backbone:2'], 'AA:BB:CC:00:00:03');
  const hosts = [
    { macAddress: 'aa-bb-cc-00-00-02', onInterface: 'ether3' },
    { macAddress: 'AA:BB:CC:00:00:03', onInterface: 'ether4' },
    { macAddress: 'AA:BB:CC:00:00:10', onInterface: 'ether1' }
  ];

  test('combines WAN rates and bridge hosts through the configured transport', async () => {
    const requests: RouterRequest[] = [];
    const transport: RouterTransport = async (request) => {
      requests.push(request);
      if (request.path.startsWith('/interface/list/member')) return [{ interface: 'WAN1-STARLINK' }];
      if (request.path === '/interface/monitor-traffic') return [{ name: 'WAN1-STARLINK', 'rx-bits-per-second': '12400000', 'tx-bits-per-second': '2000000' }];
      if (request.path.startsWith('/interface/bridge/host')) return [{ 'mac-address': 'AA:BB:CC:00:00:02', 'on-interface': 'ether3', local: 'false' }];
      if (request.path.startsWith('/interface?')) return [
        { name: 'WAN1-STARLINK', running: 'true', disabled: 'false' },
        { name: 'ether3', running: 'true', disabled: 'false' },
        { name: 'bridge-LAN', type: 'bridge', running: 'true', disabled: 'false' },
        { name: 'lo', type: 'loopback', running: 'true', disabled: 'false' },
        { name: '<pppoe-skn001>', type: 'pppoe-in', running: 'true', disabled: 'false' }
      ];
      throw new Error(request.path);
    };
    const config = { host: 'router-test', port: 443, user: 'ispm' } as RouterConfig;
    const result = await readTopologyLive(transport, config, [router, switchNode], 1);
    expect(result.interfaces.map((item) => item.name)).toEqual(['WAN1-STARLINK', 'ether3']);
    expect(result.interfaces).toMatchObject([
      { name: 'WAN1-STARLINK', running: true, downBps: 12400000 },
      { name: 'ether3', running: true, downBps: null }
    ]);
    expect(result.seen).toEqual([{ deviceId: 2, onInterface: 'ether3' }]);
    expect(requests.filter((item) => item.method !== 'GET').map((item) => item.path)).toEqual(['/interface/monitor-traffic']);
  });

  test('checks direct and downstream ports without treating Starlink WAN as a bridge host', () => {
    const checks = checkTopologyPorts([router, starlink, switchNode, antenna], 1, hosts);
    expect(checks.find((item) => item.deviceId === 10)).toBeUndefined();
    expect(checks.find((item) => item.deviceId === 2)).toMatchObject({ portCheck: 'ok', proposal: null });
    expect(checks.find((item) => item.deviceId === 3)).toMatchObject({ portCheck: 'divergente', proposal: null, registeredInterface: 'ether3' });
  });

  test('proposes a port only for a directly connected device', () => {
    const checks = checkTopologyPorts([router, node(2, ['backbone:1'], 'AA:BB:CC:00:00:02')], 1, hosts);
    expect(checks[0].proposal).toEqual({ deviceId: 2, routerInterface: 'ether3' });
    expect(checks[0].portCheck).toBe('sem_registo');
  });

  test('infers the port of an unmanaged switch from the antennas behind it', () => {
    const unmanaged = node(2, ['backbone:1'], null);
    const a = node(3, ['backbone:2'], 'AA:BB:CC:00:00:03');
    const b = node(4, ['backbone:2'], 'AA:BB:CC:00:00:04');
    const agree = checkTopologyPorts([router, unmanaged, a, b], 1, [
      { macAddress: 'AA:BB:CC:00:00:03', onInterface: 'ether3' },
      { macAddress: 'AA:BB:CC:00:00:04', onInterface: 'ether3' }
    ]);
    expect(agree.find((item) => item.deviceId === 2)).toMatchObject({ onInterface: 'ether3', proposal: { deviceId: 2, routerInterface: 'ether3' } });
    const disagree = checkTopologyPorts([router, unmanaged, a, b], 1, [
      { macAddress: 'AA:BB:CC:00:00:03', onInterface: 'ether3' },
      { macAddress: 'AA:BB:CC:00:00:04', onInterface: 'ether4' }
    ]);
    expect(disagree.find((item) => item.deviceId === 2)).toMatchObject({ portCheck: 'sem_registo', proposal: null });
  });

  test('distinguishes a device not seen from one without a MAC', () => {
    const checks = checkTopologyPorts([router, switchNode, node(3, ['backbone:2'], 'AA:BB:CC:00:00:03'), node(4, ['backbone:2'], null)], 1, []);
    expect(checks.find((item) => item.deviceId === 3)?.portCheck).toBe('nao_visto');
    expect(checks.find((item) => item.deviceId === 4)?.portCheck).toBe('sem_registo');
  });

  test('does not propose a port when the same MAC is learned on conflicting ports', () => {
    const checks = checkTopologyPorts([router, switchNode], 1, [
      { macAddress: 'AA:BB:CC:00:00:02', onInterface: 'ether3' },
      { macAddress: 'aa-bb-cc-00-00-02', onInterface: 'ether4' }
    ]);
    expect(checks[0]).toMatchObject({ portCheck: 'nao_visto', proposal: null });
  });
});
