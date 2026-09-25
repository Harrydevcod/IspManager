import type Database from 'better-sqlite3';
import {
  createProfile,
  listProfiles,
  patchProfile,
  type RouterProfile,
  type RouterTransport
} from './routeros';

/**
 * Perfis PPP dos planos (ADR 0011).
 *
 * A velocidade de um cliente vive no perfil PPP do plano. O operador pode
 * escolher um perfil que já fez no Winbox, ou pedir ao ISPM que crie o do
 * plano: copia os endereços e o DNS de um perfil-base e junta o `rate-limit`
 * tirado dos Mbps. O ISPM marca o que cria com `ispm:plano:<id>` e só volta a
 * mexer nesses, e só no limite. Nunca apaga perfis.
 */

const COMMENT_PREFIX = 'ispm:plano:';
const DEFAULT_BASE_PROFILE = 'default';
const DEFAULT_SUSPENDED_PROFILE = 'SUSPENSO';

export type PlanForProfile = {
  id: number;
  name: string;
  uploadMbps: number | null;
  downloadMbps: number | null;
  routerProfile: string | null;
};

export type PlanProfileAction =
  | { kind: 'create'; name: string; rateLimit: string; comment: string; base: RouterProfile }
  | { kind: 'update'; id: string; name: string; rateLimit: string; previous: string | null }
  | { kind: 'none'; detail: string; owned?: boolean };

/** `rate-limit` do RouterOS é rx/tx do lado do router: o que ele recebe é o upload do cliente. */
export function rateLimitFor(uploadMbps: number | null, downloadMbps: number | null): string | null {
  // Sem os dois números não se escreve velocidade nenhuma: adivinhá-la
  // estrangula quem paga.
  if (!uploadMbps || !downloadMbps || uploadMbps <= 0 || downloadMbps <= 0) return null;
  return `${uploadMbps}M/${downloadMbps}M`;
}

export function readBaseProfileName(db: Database.Database): string {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'routerosBaseProfile'`).get() as
    | { value: string }
    | undefined;
  return row?.value?.trim() || DEFAULT_BASE_PROFILE;
}

export function readSuspendedProfileName(db: Database.Database): string {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'routerosSuspendedProfile'`).get() as
    | { value: string }
    | undefined;
  return row ? row.value.trim() : DEFAULT_SUSPENDED_PROFILE;
}

/** Função pura: dado o plano e os perfis do router, o que há a fazer. */
export function planProfileAction(plan: PlanForProfile, profiles: RouterProfile[], baseName: string): PlanProfileAction {
  const name = plan.routerProfile?.trim();
  if (!name) return { kind: 'none', detail: 'Escreva primeiro o nome do perfil no plano.' };

  const rateLimit = rateLimitFor(plan.uploadMbps, plan.downloadMbps);
  const tag = `${COMMENT_PREFIX}${plan.id}`;
  const existing = profiles.find((profile) => profile.name === name);

  if (existing) {
    if (existing.comment !== tag) {
      return {
        kind: 'none',
        owned: false,
        detail: `O perfil ${name} já existe no router e não foi criado pelo ISPM para este plano: fica como está.`
      };
    }
    if (!rateLimit) return { kind: 'none', owned: true, detail: 'O plano precisa de download e upload em Mbps para ter limite.' };
    if (existing.rateLimit === rateLimit) return { kind: 'none', owned: true, detail: `O perfil ${name} já está em ${rateLimit}.` };
    return { kind: 'update', id: existing.id, name, rateLimit, previous: existing.rateLimit };
  }

  if (!rateLimit) return { kind: 'none', detail: 'O plano precisa de download e upload em Mbps para criar o perfil.' };
  const base = profiles.find((profile) => profile.name === baseName);
  if (!base) {
    return { kind: 'none', detail: `O perfil-base ${baseName} não existe no router. Escolha outro nas Definições, aba Rede.` };
  }
  return { kind: 'create', name, rateLimit, comment: tag, base };
}

export type PlanProfileResult = { dryRun: boolean; applied: boolean; action: PlanProfileAction };

/** Lê o router, decide e, fora do ensaio, aplica. `null` se o plano não existe. */
export async function applyPlanProfile(
  db: Database.Database,
  deps: { transport: RouterTransport; dryRun: boolean },
  planId: number
): Promise<PlanProfileResult | null> {
  const plan = db.prepare(`
    SELECT id, name, upload_mbps AS uploadMbps, download_mbps AS downloadMbps, router_profile AS routerProfile
    FROM internet_plans WHERE id = ?
  `).get(planId) as PlanForProfile | undefined;
  if (!plan) return null;

  const action = planProfileAction(plan, await listProfiles(deps.transport), readBaseProfileName(db));
  if (deps.dryRun || action.kind === 'none') return { dryRun: deps.dryRun, applied: false, action };

  if (action.kind === 'create') {
    await createProfile(deps.transport, { name: action.name, rateLimit: action.rateLimit, comment: action.comment, base: action.base });
  } else {
    await patchProfile(deps.transport, action.id, { rateLimit: action.rateLimit });
  }
  return { dryRun: false, applied: true, action };
}

/** Nome dado ao perfil de um plano gravado sem nenhum: estável, e só do ISPM. */
export function defaultProfileName(planId: number): string {
  return `ispm-plano-${planId}`;
}

export type PlanSyncStatus = 'synced' | 'pending' | 'external' | 'error' | 'dry_run';
export type PlanSyncSummary = { plans: number; applied: number; failed: number };

const upsertSync = `
  INSERT INTO plan_router_sync (plan_id, status, detail, last_error, checked_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(plan_id) DO UPDATE SET
    status = excluded.status, detail = excluded.detail,
    last_error = excluded.last_error, checked_at = excluded.checked_at
`;

function describeAction(action: Exclude<PlanProfileAction, { kind: 'none' }>, dryRun: boolean): string {
  const verb = action.kind === 'create' ? (dryRun ? 'Criaria' : 'Criou') : dryRun ? 'Atualizaria' : 'Atualizou';
  return `${verb} o perfil ${action.name} com ${action.rateLimit}`;
}

function statusOf(action: Extract<PlanProfileAction, { kind: 'none' }>): PlanSyncStatus {
  if (action.owned === true) return 'synced';
  if (action.owned === false) return 'external';
  return 'pending';
}

/**
 * Passagem dos perfis dos planos: corre antes da dos secrets, para um secret
 * nunca apontar para um perfil que ainda não existe. Cada plano com nome de
 * perfil é decidido por `planProfileAction`; o resultado fica em
 * `plan_router_sync`. Uma falha num plano não impede os outros e a passagem
 * seguinte volta a tentar.
 */
export async function syncPlanProfiles(
  db: Database.Database,
  deps: { transport: RouterTransport; dryRun: boolean }
): Promise<PlanSyncSummary> {
  const plans = db.prepare(`
    SELECT id, name, upload_mbps AS uploadMbps, download_mbps AS downloadMbps, router_profile AS routerProfile
    FROM internet_plans
    WHERE router_profile IS NOT NULL AND TRIM(router_profile) <> ''
    ORDER BY id
  `).all() as PlanForProfile[];
  if (plans.length === 0) return { plans: 0, applied: 0, failed: 0 };

  const profiles = await listProfiles(deps.transport);
  const baseName = readBaseProfileName(db);
  const record = db.prepare(upsertSync);
  let applied = 0;
  let failed = 0;

  for (const plan of plans) {
    const action = planProfileAction(plan, profiles, baseName);
    if (action.kind === 'none') {
      record.run(plan.id, statusOf(action), action.detail, null);
      continue;
    }
    const detail = describeAction(action, deps.dryRun);
    if (deps.dryRun) {
      record.run(plan.id, 'dry_run', detail, null);
      continue;
    }
    try {
      if (action.kind === 'create') {
        await createProfile(deps.transport, { name: action.name, rateLimit: action.rateLimit, comment: action.comment, base: action.base });
      } else {
        await patchProfile(deps.transport, action.id, { rateLimit: action.rateLimit });
      }
      applied += 1;
      record.run(plan.id, 'synced', detail, null);
      recordPlanAudit(db, `router_profile_${action.kind}`, plan.id, `${detail} para o plano ${plan.name}`);
    } catch (err) {
      failed += 1;
      record.run(plan.id, 'error', detail, err instanceof Error ? err.message : String(err));
    }
  }

  return { plans: plans.length, applied, failed };
}

function recordPlanAudit(db: Database.Database, action: string, planId: number, summary: string): void {
  try {
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary)
      VALUES (NULL, 'sistema', NULL, ?, 'plan', ?, ?)
    `).run(action, String(planId), summary);
  } catch {
    // A auditoria não pode fazer falhar o que já aconteceu no router.
  }
}
