import type { PlanRow } from '../../types';

export const ROUTER_API = 'http://127.0.0.1:3001/api/network/router';

/** Router desligado ou em baixo é um estado do ecrã: o servidor responde sempre 200. */
export type Live<T> = ({ available: true; dryRun: boolean } & T) | { available: false; reason: string };

export type RouterFinding = { services: string[]; severity: 'grave' | 'aviso'; detail: string; command: string };

export type RouterOverview = {
  host: string;
  system: {
    identity: string | null;
    version: string | null;
    boardName: string | null;
    architecture: string | null;
    uptime: string | null;
    cpuLoad: number | null;
    freeMemory: number | null;
    totalMemory: number | null;
  };
  secrets: number;
  disabledSecrets: number;
  activeSessions: number;
  divergences: number;
  findings: RouterFinding[];
  lastEnforcement: { status: 'ok' | 'skipped' | 'error'; ranAt: string } | null;
};

export type SessionState = 'online' | 'offline' | 'desativado' | 'sem_secret' | 'sem_servico';

export type RouterSession = {
  serviceId: number | null;
  clientName: string | null;
  login: string;
  state: SessionState;
  online: boolean;
  suspended: boolean;
  address: string | null;
  uptime: string | null;
  routerProfile: string | null;
};

export type RouterInterface = {
  name: string;
  type: string | null;
  running: boolean;
  disabled: boolean;
  macAddress: string | null;
  rxBytes: number | null;
  txBytes: number | null;
  comment: string | null;
};

export type RouterLogEntry = { id: string; time: string; topics: string; message: string };

export type RouterLoginFailures = { address: string; via: string; users: string[]; count: number };

type MacContext = { clientName: string | null; vendor: string | null };
export type RouterRogueDhcp = { port: string; address: string; mac: string; count: number } & MacContext;
export type RouterPppoeDrops = { login: string; reasons: string[]; count: number; clientName: string | null };
export type RouterDhcpChurn = { mac: string; address: string; hostname: string | null; count: number } & MacContext;

export type RouterLog = {
  entries: RouterLogEntry[];
  loginFailures: RouterLoginFailures[];
  rogueDhcp: RouterRogueDhcp[];
  pppoeDrops: RouterPppoeDrops[];
  dhcpChurn: RouterDhcpChurn[];
};

export type LogFinding = { key: string; severity: 'grave' | 'aviso'; title: string; detail: string };

const times = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const who = (...parts: Array<string | null>) => parts.filter(Boolean).join(' · ');

/** Os resumos do registo numa lista só, pela ordem em que pedem ação. */
export function logFindings(log: Omit<RouterLog, 'entries'>): LogFinding[] {
  return [
    ...log.rogueDhcp.map((row) => ({
      key: `dhcp-${row.mac}`,
      severity: 'grave' as const,
      title: `DHCP intruso na porta ${row.port}${row.vendor ? ` · ${row.vendor}` : ''}`,
      detail: `${who(row.mac, row.address, row.clientName)} — ${times(row.count, 'aviso', 'avisos')}. O dhcp-snooping está a travá-lo; normalmente é o router de um cliente com o cabo na porta LAN em vez da WAN.`
    })),
    ...log.loginFailures.map((row) => ({
      key: `login-${row.address}-${row.via}`,
      severity: 'aviso' as const,
      title: `Falhas de login de ${row.address}`,
      detail: `${times(row.count, 'tentativa', 'tentativas')} por ${row.via} · ${row.users.join(', ')}`
    })),
    ...log.pppoeDrops.map((row) => ({
      key: `ppp-${row.login}`,
      severity: 'aviso' as const,
      title: `PPPoE de ${row.clientName ?? row.login} caiu ${times(row.count, 'vez', 'vezes')}`,
      detail: `${row.login} · ${row.reasons.join('; ')}`
    })),
    ...log.dhcpChurn.map((row) => ({
      key: `churn-${row.mac}`,
      severity: 'aviso' as const,
      title: `${row.hostname ?? row.mac} em ciclo de DHCP`,
      detail: `${who(row.mac, row.address, row.vendor, row.clientName)} — largou o IP ${row.count} vezes. Enche o registo e esconde o resto; um IP reservado costuma resolver.`
    }))
  ];
}

/** O RouterOS separa os tópicos por vírgula ("system,error,critical"). */
export function logTone(topics: string): Tone {
  const list = topics.split(',');
  if (list.includes('critical') || list.includes('error')) return 'danger';
  if (list.includes('warning')) return 'warn';
  return 'neutral';
}

export type RouterProfileOption ={ name: string; rateLimit: string | null; ownerPlanId: number | null };

type Tone = 'success' | 'danger' | 'info' | 'neutral' | 'warn';

export const SESSION_STATE: Record<SessionState, { label: string; tone: Tone; rank: number }> = {
  online: { label: 'Online', tone: 'success', rank: 0 },
  offline: { label: 'Offline', tone: 'neutral', rank: 1 },
  desativado: { label: 'Desativado no router', tone: 'warn', rank: 2 },
  sem_secret: { label: 'Sem secret no router', tone: 'danger', rank: 3 },
  sem_servico: { label: 'Sem serviço no ISPM', tone: 'info', rank: 4 }
};

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
const decimal = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 1 });

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${decimal.format(value)} ${UNITS[unit]}`;
}

type PlanRef = Pick<PlanRow, 'id' | 'name' | 'routerProfile' | 'routerSyncStatus'>;

export type ProfileRow = RouterProfileOption & {
  plans: PlanRef[];
  managedByIspm: boolean;
  /** Um plano aponta para ele, mas o router não o tem. */
  missing: boolean;
};

/** Os perfis do router, cada um com os planos que o usam; no fim os que os planos pedem e faltam. */
export function profileRows(profiles: RouterProfileOption[], plans: PlanRef[]): ProfileRow[] {
  const known = new Set(profiles.map((profile) => profile.name));
  const byProfile = (name: string) => plans.filter((plan) => plan.routerProfile?.trim() === name);
  const rows: ProfileRow[] = profiles.map((profile) => ({
    ...profile,
    plans: byProfile(profile.name),
    managedByIspm: profile.ownerPlanId !== null,
    missing: false
  }));
  const missing = [...new Set(plans.map((plan) => plan.routerProfile?.trim()).filter((name): name is string => Boolean(name) && !known.has(name!)))];
  for (const name of missing) {
    rows.push({ name, rateLimit: null, ownerPlanId: null, plans: byProfile(name), managedByIspm: false, missing: true });
  }
  return rows;
}
