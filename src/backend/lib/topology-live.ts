import { normalizeMacAddress } from '../../shared/mac';
import type { TopologyBackboneNode, TopologyPortCheck } from '../../shared/topology';
import { listBridgeHosts, listInterfaces, type RouterConfig, type RouterTransport } from './routeros';
import { readWanInterfaces } from './router-live';

type BridgeHost = { macAddress: string; onInterface: string };

function unambiguousPorts(hosts: BridgeHost[]): Map<string, string> {
  const ports = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const host of hosts) {
    const mac = normalizeMacAddress(host.macAddress);
    if (!mac || ambiguous.has(mac)) continue;
    const previous = ports.get(mac);
    if (previous && previous !== host.onInterface) {
      ports.delete(mac);
      ambiguous.add(mac);
    } else ports.set(mac, host.onInterface);
  }
  return ports;
}

/** Resolve a porta registada no primeiro filho do router; não infere mudanças nos ramos a jusante. */
export function checkTopologyPorts(backbones: TopologyBackboneNode[], routerDeviceId: number, hosts: BridgeHost[]): TopologyPortCheck[] {
  const routerId = `backbone:${routerDeviceId}`;
  const byId = new Map(backbones.map((node) => [node.id, node]));
  const seenByMac = unambiguousPorts(hosts);
  const directChild = (start: TopologyBackboneNode): TopologyBackboneNode | null => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length) {
      const node = pending.shift()!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (node.parentIds.includes(routerId as `backbone:${number}`)) return node;
      pending.push(...node.parentIds.flatMap((id) => id === 'root:isp' ? [] : byId.get(id) ?? []));
    }
    return null;
  };
  const seenOf = (node: TopologyBackboneNode) =>
    node.macAddress ? seenByMac.get(normalizeMacAddress(node.macAddress)!) ?? null : null;
  const childOf = new Map(backbones.map((node) => [node.id, node.backboneDeviceId === routerDeviceId ? null : directChild(node)]));
  // Um switch não gerido não tem MAC na bridge: a porta dele é a porta onde o
  // router vê os equipamentos a jusante — desde que todos concordem.
  const inferredPort = (child: TopologyBackboneNode): string | null => {
    const ports = new Set(backbones.flatMap((node) =>
      node.id !== child.id && childOf.get(node.id)?.id === child.id ? [seenOf(node) ?? []].flat() : []));
    return ports.size === 1 ? [...ports][0] : null;
  };
  return backbones.flatMap((node) => {
    if (node.backboneDeviceId === routerDeviceId) return [];
    const child = childOf.get(node.id);
    if (!child) return []; // Fontes Internet/WAN não são verificadas por MAC.
    const onInterface = seenOf(node) ?? (!node.macAddress && child.id === node.id ? inferredPort(node) : null);
    const registeredInterface = child.routerInterface;
    const portCheck: TopologyPortCheck['portCheck'] = !node.macAddress && !onInterface
      ? 'sem_registo'
      : !onInterface ? 'nao_visto'
        : !registeredInterface ? 'sem_registo'
          : onInterface === registeredInterface ? 'ok' : 'divergente';
    return [{
      deviceId: node.backboneDeviceId, onInterface, registeredInterface, portCheck,
      proposal: child.id === node.id && onInterface && onInterface !== registeredInterface
        ? { deviceId: node.backboneDeviceId, routerInterface: onInterface }
        : null
    }];
  });
}

export async function readTopologyLive(transport: RouterTransport, config: RouterConfig, backbones: TopologyBackboneNode[], routerDeviceId: number | null) {
  const [listed, hosts] = await Promise.all([listInterfaces(transport), listBridgeHosts(transport)]);
  const wan = await readWanInterfaces(transport, config, listed);
  const wanRates = 'interfaces' in wan && wan.interfaces ? wan.interfaces : [];
  const rates = new Map(wanRates.map((item) => [item.name, item]));
  // Só portas onde se liga um cabo: a bridge, o loopback e as sessões PPPoE
  // dinâmicas (`<pppoe-...>`) não são sítio de equipamento nenhum.
  const ports = listed.filter((item) => !['bridge', 'loopback', 'pppoe-in', 'pppoe-out'].includes(item.type ?? '') && !item.name.startsWith('<'));
  const interfaces = ports.map((item) => rates.get(item.name) ?? ({
    name: item.name, running: item.running && !item.disabled, downBps: null, upBps: null
  }));
  const byMac = new Map(backbones.filter((node) => node.macAddress).map((node) => [normalizeMacAddress(node.macAddress), node.backboneDeviceId]));
  const seen = [...unambiguousPorts(hosts)].flatMap(([mac, onInterface]) => {
    const deviceId = byMac.get(mac);
    return deviceId === undefined ? [] : [{ deviceId, onInterface }];
  });
  return { interfaces, seen, checks: routerDeviceId === null ? [] : checkTopologyPorts(backbones, routerDeviceId, hosts) };
}
