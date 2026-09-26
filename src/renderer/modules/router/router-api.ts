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

export type RouterProfileOption = { name: string; rateLimit: string | null; ownerPlanId: number | null };

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
