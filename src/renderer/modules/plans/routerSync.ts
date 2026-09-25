import type { PlanRow } from '../../types';

type Tone = 'success' | 'danger' | 'info' | 'neutral' | 'warn';
type SyncFields = Pick<PlanRow, 'routerSyncStatus' | 'routerSyncDetail' | 'routerSyncError'>;

const LABELS: Record<NonNullable<PlanRow['routerSyncStatus']>, { label: string; tone: Tone }> = {
  synced: { label: 'Pronto', tone: 'success' },
  pending: { label: 'Pendente', tone: 'warn' },
  external: { label: 'Do operador', tone: 'neutral' },
  error: { label: 'Erro', tone: 'danger' },
  dry_run: { label: 'Em ensaio', tone: 'info' }
};

/** Estado do perfil PPP do plano no router (ADR 0011), como a lista o mostra. */
export function routerSyncBadge(plan: SyncFields): { label: string; tone: Tone; title: string } {
  if (!plan.routerSyncStatus) {
    return { label: 'Por sincronizar', tone: 'neutral', title: 'O router ainda não foi lido para este plano.' };
  }
  const detail = plan.routerSyncDetail ?? '';
  const title = plan.routerSyncError ? `${detail} — ${plan.routerSyncError}` : detail;
  return { ...LABELS[plan.routerSyncStatus], title };
}
