import type Database from 'better-sqlite3';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import { createTransport, describeRouterFailure, isRouterConfigured, listInterfaceListMembers, listInterfaces, monitorTraffic, readRouterConfig, type RouterConfig, type RouterTransport } from './routeros';

export async function readRouterLive<T extends object>(db: Database.Database, read: (transport: RouterTransport, config: RouterConfig) => Promise<T>) {
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) {
    return { available: false as const, reason: 'Integração MikroTik desligada ou por configurar' };
  }
  // Fora da rede já se sabe a resposta: tentar outra vez só prende o ecrã nos 10 s do timeout
  // (e numa rede alheia mandaria as credenciais a outro aparelho).
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { available: false as const, reason: offNetworkReason(presence) };
  try {
    return { available: true as const, dryRun: config.dryRun, ...(await read(createTransport(config), config)) };
  } catch (err) {
    const failure = describeRouterFailure(err);
    return { available: false as const, reason: `${failure.title}. ${failure.detail}` };
  }
}

let wanNames: { key: string; names: string[]; at: number } | null = null;

export async function readWanInterfaces(transport: RouterTransport, config: RouterConfig, listed?: Awaited<ReturnType<typeof listInterfaces>>) {
  const key = `${config.host}:${config.port}:${config.user}`;
  if (!wanNames || wanNames.key !== key || Date.now() - wanNames.at > 60_000) {
    wanNames = { key, names: await listInterfaceListMembers(transport, 'WAN'), at: Date.now() };
  }
  const names = wanNames.names;
  if (names.length === 0) return { missing: true as const };
  const [interfaces, traffic] = await Promise.all([
    listed ? Promise.resolve(listed) : listInterfaces(transport),
    monitorTraffic(transport, names)
  ]);
  const rates = new Map(traffic.map((item) => [item.name, item]));
  return {
    sampledAt: Date.now(),
    interfaces: interfaces.filter((item) => names.includes(item.name)).map(({ name, running, disabled }) => ({
      name, running: running && !disabled,
      downBps: rates.get(name)?.rxBps ?? null,
      upBps: rates.get(name)?.txBps ?? null
    }))
  };
}
