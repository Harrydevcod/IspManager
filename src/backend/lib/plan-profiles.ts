import type Database from 'better-sqlite3';
import {
  createProfile,
  listProfiles,
  patchProfile,
  type ProfileFields,
  type RouterProfile,
  type RouterTransport
} from './routeros';

/**
 * Perfis PPP dos planos (ADR 0011).
 *
 * A velocidade de um cliente vive no perfil PPP do plano. O operador pode
 * escolher um perfil que já fez no Winbox, ou deixar o ISPM criar o do plano:
 * os campos de rede vêm das Definições (gateway, pool, lista de interfaces,
 * DNS, fila-mãe) e o `rate-limit` sai dos Mbps. O ISPM marca o que cria com
 * `ispm:plano:<id>` e só volta a mexer nesses. Nunca apaga perfis.
 */

const COMMENT_PREFIX = 'ispm:plano:';
const DEFAULT_BASE_PROFILE = 'default';
const DEFAULT_SUSPENDED_PROFILE = 'SUSPENSO';
export const DEFAULT_PPP_INTERFACE_LIST = 'PPPOE';

export type PlanForProfile = {
  id: number;
  name: string;
  uploadMbps: number | null;
  downloadMbps: number | null;
  routerProfile: string | null;
};

/**
 * O que um perfil de plano tem de levar para o cliente ter IP e cair nas regras da firewall.
 * Em 2026-10-09 o `PLANO-20-10` saiu só com nome e limite (o perfil-base `default` não tem
 * endereços): 24 secrets ficariam sem IP e fora da lista `PPPOE`.
 */
export type PlanNetwork = {
  localAddress: string;
  remotePool: string;
  interfaceList: string;
  dnsServer: string;
  parentQueue: string;
};

const NETWORK_LABELS: Record<keyof PlanNetwork, string> = {
  localAddress: 'gateway PPPoE',
  remotePool: 'pool de endereços',
  interfaceList: 'lista de interfaces',
  dnsServer: 'DNS',
  parentQueue: 'fila-mãe'
};

type ProfileDiff = { before: ProfileFields; after: ProfileFields };

export type PlanProfileAction =
  | { kind: 'create'; name: string; fields: ProfileFields }
  | { kind: 'update'; id: string; name: string; diff: ProfileDiff }
  | { kind: 'none'; detail: string; owned?: boolean };

/** `rate-limit` do RouterOS é rx/tx do lado do router: o que ele recebe é o upload do cliente. */
export function rateLimitFor(uploadMbps: number | null, downloadMbps: number | null): string | null {
  // Sem os dois números não se escreve velocidade nenhuma: adivinhá-la
  // estrangula quem paga.
  if (!uploadMbps || !downloadMbps || uploadMbps <= 0 || downloadMbps <= 0) return null;
  return `${uploadMbps}M/${downloadMbps}M`;
}

const readSetting = (db: Database.Database, key: string) =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

export function readBaseProfileName(db: Database.Database): string {
  return readSetting(db, 'routerosBaseProfile')?.trim() || DEFAULT_BASE_PROFILE;
}

export function readSuspendedProfileName(db: Database.Database): string {
  const value = readSetting(db, 'routerosSuspendedProfile');
  return value === undefined ? DEFAULT_SUSPENDED_PROFILE : value.trim();
}

/** As definições de rede dos perfis. O DNS em branco é o gateway; a lista em branco é `PPPOE`. */
export function readPlanNetwork(db: Database.Database): PlanNetwork {
  const value = (key: string) => readSetting(db, key)?.trim() ?? '';
  const localAddress = value('routerosPppLocalAddress');
  return {
    localAddress,
    remotePool: value('routerosPppRemotePool'),
    interfaceList: value('routerosPppInterfaceList') || DEFAULT_PPP_INTERFACE_LIST,
    dnsServer: value('routerosPppDns') || localAddress,
    parentQueue: value('routerosPppParentQueue')
  };
}

/** Os campos de rede de um perfil de plano, ou o que falta nas Definições para os ter. */
export function networkFields(network: PlanNetwork): { fields: ProfileFields } | { missing: string[] } {
  const missing = (Object.keys(NETWORK_LABELS) as Array<keyof PlanNetwork>)
    .filter((key) => !network[key])
    .map((key) => NETWORK_LABELS[key]);
  if (missing.length > 0) return { missing };
  return {
    fields: {
      'local-address': network.localAddress,
      'remote-address': network.remotePool,
      'interface-list': network.interfaceList,
      'dns-server': network.dnsServer,
      'parent-queue': network.parentQueue,
      'only-one': 'yes'
    }
  };
}

const CURRENT: Record<string, (profile: RouterProfile) => string | null> = {
  'local-address': (profile) => profile.localAddress,
  'remote-address': (profile) => profile.remoteAddress,
  'interface-list': (profile) => profile.interfaceList,
  'dns-server': (profile) => profile.dnsServer,
  'parent-queue': (profile) => profile.parentQueue,
  'only-one': (profile) => profile.onlyOne,
  'rate-limit': (profile) => profile.rateLimit
};

/**
 * Só a primeira parte do `rate-limit` (`10M/20M`) é do plano: o burst que o operador
 * acrescentar no router (`10M/20M 20M/30M …`) fica.
 */
const sameRate = (current: string | null, wanted: string) => current?.trim().split(/\s+/)[0] === wanted;

/** Função pura: dado o plano, os perfis do router e as definições de rede, o que há a fazer. */
export function planProfileAction(plan: PlanForProfile, profiles: RouterProfile[], network: PlanNetwork): PlanProfileAction {
  const name = plan.routerProfile?.trim();
  if (!name) return { kind: 'none', detail: 'Escreva primeiro o nome do perfil no plano.' };

  const tag = `${COMMENT_PREFIX}${plan.id}`;
  const existing = profiles.find((profile) => profile.name === name);
  if (existing && existing.comment !== tag) {
    return {
      kind: 'none',
      owned: false,
      detail: `O perfil ${name} já existe no router e não foi criado pelo ISPM para este plano: fica como está.`
    };
  }

  const rateLimit = rateLimitFor(plan.uploadMbps, plan.downloadMbps);
  if (!rateLimit) {
    return {
      kind: 'none',
      ...(existing && { owned: true }),
      detail: `O plano precisa de download e upload em Mbps para ${existing ? 'ter limite' : 'criar o perfil'}.`
    };
  }
  const wanted = networkFields(network);
  if ('missing' in wanted) {
    return {
      kind: 'none',
      detail: `Falta nas Definições, aba Rede: ${wanted.missing.join(', ')}. Sem isso o perfil ${name} deixava os clientes sem IP.`
    };
  }

  if (!existing) {
    return { kind: 'create', name, fields: { name, comment: tag, 'rate-limit': rateLimit, ...wanted.fields } };
  }
  const diff: ProfileDiff = { before: {}, after: {} };
  const target: ProfileFields = { ...wanted.fields, 'rate-limit': rateLimit };
  for (const [field, value] of Object.entries(target) as Array<[keyof ProfileFields, string]>) {
    const current = CURRENT[field](existing);
    if (field === 'rate-limit' ? sameRate(current, value) : current === value) continue;
    diff.before[field] = current ?? '';
    diff.after[field] = value;
  }
  if (Object.keys(diff.after).length === 0) {
    return { kind: 'none', owned: true, detail: `O perfil ${name} está completo e em ${rateLimit}.` };
  }
  return { kind: 'update', id: existing.id, name, diff };
}

export function describeAction(action: Exclude<PlanProfileAction, { kind: 'none' }>, dryRun: boolean): string {
  if (action.kind === 'create') return `${dryRun ? 'Criaria' : 'Criou'} o perfil ${action.name} com ${action.fields['rate-limit']}`;
  return `${dryRun ? 'Corrigiria' : 'Corrigiu'} o perfil ${action.name}: ${Object.keys(action.diff.after).join(', ')}`;
}

async function applyAction(transport: RouterTransport, action: Exclude<PlanProfileAction, { kind: 'none' }>) {
  // Corrigir é sempre PATCH no mesmo `.id`: apagar e recriar soltava os secrets do perfil.
  if (action.kind === 'create') await createProfile(transport, action.fields);
  else await patchProfile(transport, action.id, action.diff.after);
}

export const auditMetadata = (action: Exclude<PlanProfileAction, { kind: 'none' }>) =>
  action.kind === 'create' ? { profile: action.name, before: null, after: action.fields } : { profile: action.name, ...action.diff };

/** `summary`: a frase do que fez (ou faria em ensaio), para o ecrã e a auditoria. */
export type PlanProfileResult = { dryRun: boolean; applied: boolean; action: PlanProfileAction; summary: string };

const PLAN_COLUMNS = 'id, name, upload_mbps AS uploadMbps, download_mbps AS downloadMbps, router_profile AS routerProfile';

/** Lê o router, decide e, fora do ensaio, aplica. `null` se o plano não existe. */
export async function applyPlanProfile(
  db: Database.Database,
  deps: { transport: RouterTransport; dryRun: boolean },
  planId: number
): Promise<PlanProfileResult | null> {
  const plan = db.prepare(`SELECT ${PLAN_COLUMNS} FROM internet_plans WHERE id = ?`).get(planId) as PlanForProfile | undefined;
  if (!plan) return null;

  const action = planProfileAction(plan, await listProfiles(deps.transport), readPlanNetwork(db));
  if (action.kind === 'none') return { dryRun: deps.dryRun, applied: false, action, summary: action.detail };
  if (deps.dryRun) return { dryRun: true, applied: false, action, summary: describeAction(action, true) };

  await applyAction(deps.transport, action);
  return { dryRun: false, applied: true, action, summary: describeAction(action, false) };
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
    SELECT ${PLAN_COLUMNS} FROM internet_plans
    WHERE router_profile IS NOT NULL AND TRIM(router_profile) <> ''
    ORDER BY id
  `).all() as PlanForProfile[];
  if (plans.length === 0) return { plans: 0, applied: 0, failed: 0 };

  const record = db.prepare(upsertSync);
  let profiles: RouterProfile[];
  try {
    profiles = await listProfiles(deps.transport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const plan of plans) record.run(plan.id, 'error', 'Ler perfis PPP do router', message);
    return { plans: plans.length, applied: 0, failed: plans.length };
  }
  const network = readPlanNetwork(db);
  let applied = 0;
  let failed = 0;

  for (const plan of plans) {
    const action = planProfileAction(plan, profiles, network);
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
      await applyAction(deps.transport, action);
      applied += 1;
      record.run(plan.id, 'synced', detail, null);
      recordPlanAudit(db, `router_profile_${action.kind}`, plan.id, `${detail} para o plano ${plan.name}`, auditMetadata(action));
    } catch (err) {
      failed += 1;
      record.run(plan.id, 'error', detail, err instanceof Error ? err.message : String(err));
    }
  }

  return { plans: plans.length, applied, failed };
}

function recordPlanAudit(db: Database.Database, action: string, planId: number, summary: string, metadata: object): void {
  try {
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary, metadata_json)
      VALUES (NULL, 'sistema', NULL, ?, 'plan', ?, ?, ?)
    `).run(action, String(planId), summary, JSON.stringify(metadata));
  } catch {
    // A auditoria não pode fazer falhar o que já aconteceu no router.
  }
}
