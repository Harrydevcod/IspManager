export const PLAN_CHANGE_API = 'http://127.0.0.1:3001/api/plans/bulk-change';

export type DropMode = 'none' | 'now' | 'scheduled';

export type PreviewOutcome = 'change' | 'unchanged' | 'suspended' | 'no_secret' | 'no_pppoe' | 'cancelled';

export type PreviewRow = {
  serviceId: number;
  clientName: string;
  clientCode: string;
  status: string;
  login: string | null;
  fromPlanName: string | null;
  fromValueCve: number;
  toValueCve: number;
  rentalCve: number;
  fromProfile: string | null;
  toProfile: string | null;
  online: boolean;
  routerChange: boolean;
  outcome: PreviewOutcome;
};

export type PlanChangePreview = {
  targetPlan: { id: number; name: string; monthlyPriceCve: number; routerProfile: string | null } | null;
  rows: PreviewRow[];
  groups: Array<{ planName: string; count: number }>;
  toChange: number;
  sessionsOnline: number;
  blockers: string[];
  dryRun: boolean;
};

export type ItemStatus = 'queued' | 'pending' | 'applied' | 'unchanged' | 'failed' | 'not_processed';
export type BatchStatus = 'running' | 'done' | 'cancelled' | 'stopped';

export type PlanChangeItem = {
  id: number;
  serviceId: number;
  clientName: string;
  login: string | null;
  fromPlanName: string | null;
  fromValueCve: number;
  toValueCve: number;
  status: ItemStatus;
  note: string | null;
  error: string | null;
  sessionDroppedAt: string | null;
  processedAt: string | null;
};

export type PlanChangeBatch = {
  id: number;
  targetPlanName: string;
  reason: string | null;
  updatePrice: number;
  dropMode: DropMode;
  dropAt: string | null;
  dropStatus: 'pending' | 'done' | 'expired' | 'cancelled' | null;
  dryRun: number;
  status: BatchStatus;
  stopReason: string | null;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
  counts: Record<ItemStatus, number>;
  items?: PlanChangeItem[];
};

type Tone = 'success' | 'danger' | 'info' | 'neutral' | 'warn';

export const OUTCOME: Record<PreviewOutcome, { label: string; tone: Tone; rank: number }> = {
  change: { label: 'Muda', tone: 'success', rank: 0 },
  suspended: { label: 'Muda no ISPM · continua suspenso', tone: 'warn', rank: 1 },
  no_secret: { label: 'Muda só no ISPM · sem utilizador no router', tone: 'warn', rank: 2 },
  no_pppoe: { label: 'Muda só no ISPM · sem PPPoE', tone: 'info', rank: 3 },
  unchanged: { label: 'Já está neste plano', tone: 'neutral', rank: 4 },
  cancelled: { label: 'Cancelado · fica de fora', tone: 'neutral', rank: 5 }
};

export const ITEM_STATUS: Record<ItemStatus, { label: string; tone: Tone; rank: number }> = {
  failed: { label: 'Falhou', tone: 'danger', rank: 0 },
  not_processed: { label: 'Por processar', tone: 'warn', rank: 1 },
  pending: { label: 'A aplicar', tone: 'info', rank: 2 },
  queued: { label: 'Em fila', tone: 'neutral', rank: 3 },
  applied: { label: 'Aplicado', tone: 'success', rank: 4 },
  unchanged: { label: 'Sem alteração', tone: 'neutral', rank: 5 }
};

export const BATCH_STATUS: Record<BatchStatus, { label: string; tone: Tone }> = {
  running: { label: 'A correr', tone: 'info' },
  done: { label: 'Concluído', tone: 'success' },
  cancelled: { label: 'Cancelado', tone: 'warn' },
  stopped: { label: 'Parado', tone: 'danger' }
};

/** Um lote só está bem quando nada falhou nem ficou por fazer — "concluído" sozinho não chega. */
export function batchVerdict(batch: Pick<PlanChangeBatch, 'status' | 'counts'>): { label: string; tone: Tone } {
  if (batch.status === 'done' && (batch.counts.failed > 0 || batch.counts.not_processed > 0)) {
    return { label: 'Concluído com falhas', tone: 'danger' };
  }
  return BATCH_STATUS[batch.status];
}

/** A próxima vez que o relógio local marca `HH:mm`, em ISO. Hoje se ainda não passou, senão amanhã. */
export function nextOccurrence(time: string, now = new Date()): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const at = new Date(now);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

/** As datas do lote vêm em UTC, no formato do SQLite. */
export function batchTime(value: string | null): Date | null {
  return value ? new Date(`${value.replace(' ', 'T')}Z`) : null;
}
