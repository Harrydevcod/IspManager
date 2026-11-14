import { authFetch } from '../../lib/auth';
import type { ClientFup } from '../../types';

export const FUP_API = 'http://127.0.0.1:3001/api/fup';

export type FupState = 'NORMAL' | 'AVISO' | 'LIMITADO';

export type FupUsage = {
  serviceId: number;
  clientId: number;
  username: string;
  planName: string | null;
  referenceGb: number;
  /** Plafond próprio do serviço; nulo = herda. */
  serviceReferenceGb: number | null;
  /** Plano ou predefinido: o que vale sem plafond próprio. */
  inheritedReferenceGb: number;
  peakPercent: number;
  cycleStart: string;
  cycleEnd: string;
  period: string;
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  percent: number;
  state: FupState;
  limitedNow: boolean;
};

export type FupEvent = {
  id: number;
  period: string;
  kind: 'AVISO' | 'LIMITADO' | 'RESTAURADO';
  createdAt: string;
  detail: Record<string, unknown> | null;
};

export type FupSettingRow = {
  key: string;
  type: 'NUMERO' | 'TEXTO' | 'HORA' | 'FUSO';
  label: string;
  description: string;
  default: string;
  value: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type FupHistoryRow = {
  id: number;
  key: string;
  oldValue: string | null;
  newValue: string;
  changedBy: string;
  changedAt: string;
  reason: string | null;
};

export type FupThresholds = { aviso: number; limitacao: number; acao?: 'REDUZIR' | 'BLOQUEAR'; bytesPerGb?: number };

export type FupApiError = { error: string; errors?: Record<string, string> };

export async function fupRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authFetch(`${FUP_API}${path}`, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json', ...(init.headers ?? {}) } : init.headers
  }).catch(() => { throw new Error('Sem ligação ao servidor.'); });
  const body = await response.json().catch(() => ({ error: 'Resposta inválida do servidor' }));
  if (!response.ok) throw Object.assign(new Error((body as FupApiError).error ?? 'Pedido falhou'), { body });
  return body as T;
}

/** Bytes de 1 GB na unidade das Definições; sem ela, decimal (10⁹). */
export const perGbOf = (thresholds: FupThresholds | null | undefined) => thresholds?.bytesPerGb ?? 1e9;

/** "GB" decimal ou "GiB" binário, conforme a unidade. */
export const gbLabel = (perGb: number) => (perGb === 1024 ** 3 ? 'GiB' : 'GB');

/** Consumo na unidade das Definições, com uma casa decimal (pt-PT). */
export function formatGb(bytes: number, perGb = 1e9): string {
  return `${(bytes / perGb).toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${gbLabel(perGb)}`;
}

/** Verde até ao aviso, laranja até à limitação, vermelho acima. */
export function usageTone(percent: number, thresholds: FupThresholds): 'success' | 'warn' | 'danger' {
  if (percent > thresholds.limitacao) return 'danger';
  if (percent >= thresholds.aviso) return 'warn';
  return 'success';
}

export const STATE_LABEL: Record<FupState, string> = { NORMAL: 'Normal', AVISO: 'Avisado', LIMITADO: 'Limitado' };
export const EVENT_LABEL: Record<FupEvent['kind'], string> = { AVISO: 'Aviso enviado', LIMITADO: 'Limitado no pico', RESTAURADO: 'Velocidade reposta' };

/** Junta os serviços de cada cliente: soma o consumo e fica com a maior % (o serviço mais perto do limite). */
export function summarizeByClient(usage: FupUsage[], thresholds: FupThresholds): Map<number, ClientFup> {
  const byClient = new Map<number, ClientFup>();
  for (const row of usage) {
    const current = byClient.get(row.clientId) ?? { usernames: [], percent: null, totalBytes: 0, limited: false, thresholds };
    current.usernames.push(row.username);
    current.totalBytes += row.totalBytes;
    if (row.referenceGb > 0) current.percent = Math.max(current.percent ?? 0, row.percent);
    current.limited ||= row.state === 'LIMITADO';
    byClient.set(row.clientId, current);
  }
  return byClient;
}
