import { authFetch } from '../../lib/auth';

// IPTV via VPN (ADR 0021). Espelho dos tipos de `backend/lib/iptv*.ts`: o renderer
// não importa do backend.

export const IPTV_API = 'http://127.0.0.1:3001/api/iptv';

export type IptvLegacy = { mac: string; via: 'antena' | 'router' | 'aparelho' };
export type IptvSource =
  | { kind: 'pppoe'; username: string; legacy: IptvLegacy | null }
  | ({ kind: 'mac' } & IptvLegacy)
  | { kind: 'missing'; reason: string };
export type IptvTarget = { serviceId: number; source: IptvSource };

export type IptvActive = { serviceId: number; via: 'pppoe' | 'legacy'; address: string } | { serviceId: number; via: null };
type ListEntry = { address: string; comment: string | null };
export type IptvSyncResult =
  | { status: 'idle' }
  | { error: string }
  | {
      status: 'dry_run' | 'applied';
      users: string[];
      macs: string[];
      missing: Array<{ serviceId: number; reason: string }>;
      active: IptvActive[];
      manualConflicts: ListEntry[];
      unownedManual: ListEntry[];
      foreignManual: Array<ListEntry & { holder: string }>;
      serversCovered: Array<ListEntry & { disabled: boolean }>;
      before: { mark: string; users: string[]; macs: string[] } | null;
      servers: { added: number; removed: number; renamed: number; reactivated: number };
    };
export type IptvStatus = { targets: IptvTarget[]; last: IptvSyncResult | null };

export type IptvValidation =
  | { state: 'ok'; address: string | null; via: 'pppoe' | 'legacy' }
  | { state: 'warning'; reason: string }
  | { state: 'not_found' }
  | { state: 'missing'; reason: string };
export type IptvValidateResult = {
  services: Array<{ serviceId: number; validation: IptvValidation }>;
  lanCollisions: Array<{ assignmentId: number; serviceId: number; lanCidr: string; collidesWith: string }>;
};

export type IptvCheck = {
  key: 'routing' | 'mark' | 'order' | 'tunnel' | 'killswitch' | 'filter' | 'nat';
  label: string;
  state: 'ok' | 'missing' | 'disabled' | 'stale' | 'misordered';
  detail?: string;
};

export type IptvProvider = {
  id: number;
  name: string;
  /** Um host por linha, já canónicos. */
  hosts: string;
  notes: string | null;
  active: 0 | 1;
};

/** Lê ou escreve na API do IPTV; num erro, lança a frase pt-PT que o servidor mandou. */
export async function iptvRequest<T>(url: string, init?: { method: 'PUT' | 'POST'; body: unknown }): Promise<T> {
  const response = await authFetch(url, init && {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(init.body)
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? 'Não foi possível contactar o servidor.');
  return body as T;
}

type Tone = 'success' | 'danger' | 'warn' | 'neutral' | 'info';

const VIA_LEGACY: Record<IptvLegacy['via'], string> = { antena: 'antena', router: 'router do cliente', aparelho: 'aparelho IPTV' };

/** A origem que o script segue, numa frase: o que o operador confere no router. */
export function describeSource(source: IptvSource): { text: string; tone: Tone } {
  if (source.kind === 'missing') return { text: source.reason, tone: 'warn' };
  if (source.kind === 'mac') return { text: `MAC do ${VIA_LEGACY[source.via]} ${source.mac}`, tone: 'neutral' };
  const legacy = source.legacy ? `, e o MAC do ${VIA_LEGACY[source.legacy.via]} ${source.legacy.mac} até migrar` : '';
  return { text: `PPPoE ${source.username}${legacy}`, tone: 'neutral' };
}

export function describeValidation(validation: IptvValidation): { label: string; detail: string | null; tone: Tone } {
  switch (validation.state) {
    case 'ok': return {
      label: 'Visto no router',
      detail: validation.address ? `${validation.via === 'pppoe' ? 'Sessão PPPoE' : 'Lease legacy'} ${validation.address}` : null,
      tone: 'success'
    };
    case 'warning': return { label: 'Diferente do registo', detail: validation.reason, tone: 'warn' };
    case 'not_found': return { label: 'Não encontrado', detail: 'Sem sessão, lease ou ARP com esta origem', tone: 'danger' };
    default: return { label: 'Origem em falta', detail: validation.reason, tone: 'warn' };
  }
}

export const CHECK_STATUS: Record<IptvCheck['state'], { status: 'ok' | 'warn' | 'fail'; label: string }> = {
  ok: { status: 'ok', label: 'Em ordem' },
  stale: { status: 'warn', label: 'Parado' },
  misordered: { status: 'warn', label: 'Fora de ordem' },
  missing: { status: 'fail', label: 'Em falta' },
  disabled: { status: 'fail', label: 'Desativado' }
};
