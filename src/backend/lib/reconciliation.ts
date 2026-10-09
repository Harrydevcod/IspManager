import type Database from 'better-sqlite3';
import { recordAuditStrict } from './audit';
import { loadConfirmedState, loadDesiredServices, planActions, runNetworkEnforcement, type DesiredService } from './network-enforcement';
import { readBaseProfileName, readSuspendedProfileName } from './plan-profiles';
import { patchSecret, removeActive, RouterError, type RouterActive, type RouterSecret, type RouterTransport } from './routeros';
import { changeServiceStatus } from './services';

/**
 * Reconciliação ISPM ↔ router (ADR 0014).
 *
 * O motor (`network-enforcement`) empurra o que muda no ISPM e retém o que muda
 * no router. Aqui está o resto: mostrar cada diferença com o valor dos dois
 * lados e aplicar a direção que o operador escolher. Nada neste módulo decide
 * sozinho — `resolveReconciliation` só corre a pedido, item a item.
 */

export type ReconKind = 'only_ispm' | 'only_router' | 'plan' | 'state';

export type ReconRow = {
  /** `<kind>:<id do serviço ou do secret>` — é o que o pedido de resolução devolve. */
  key: string;
  kind: ReconKind;
  serviceId: number | null;
  secretId: string | null;
  clientName: string | null;
  login: string;
  ispm: string;
  router: string;
  /** Retido à espera de decisão; falso = a passagem automática vai aplicá-lo sozinha. */
  held: boolean;
  /** Só em `only_router`: o secret tem a marca `ispm:`. Sem ela foi feito à mão. */
  managed: boolean;
  online: boolean;
  /** Só em `plan`: os planos do ISPM que usam o perfil que está no router. */
  planOptions: Array<{ id: number; name: string }>;
};

export type Reconciliation = {
  rows: ReconRow[];
  /** Serviços sem utilizador PPPoE, a quem um secret só do router pode ser associado. */
  unlinkedServices: Array<{ serviceId: number; clientName: string; clientCode: string }>;
};

const STATUS_LABEL: Record<string, string> = { active: 'Ativo', suspended: 'Suspenso', cancelled: 'Cancelado' };

type Context = {
  suspendedProfile: string;
  desired: Map<number, DesiredService>;
  secrets: Map<string, RouterSecret>;
  sessions: Map<string, RouterActive>;
};

/** O secret dá acesso à rede? Desativado e perfil de suspensão são o mesmo "não". */
function routerGivesAccess(secret: RouterSecret, suspendedProfile: string): boolean {
  return !secret.disabled && !(suspendedProfile && secret.profile === suspendedProfile);
}

function ispmGivesAccess(service: DesiredService): boolean {
  return service.enabled && !service.suspended;
}

function build(db: Database.Database, secrets: RouterSecret[], active: RouterActive[]): Reconciliation & { context: Context } {
  const suspendedProfile = readSuspendedProfileName(db);
  const desired = loadDesiredServices(db, { suspendedProfile });
  const plan = planActions(desired, secrets, {
    suspendedProfile,
    baseProfile: readBaseProfileName(db),
    confirmed: loadConfirmedState(db)
  });
  // O que o motor já vai aplicar sozinho não está à espera de ninguém.
  const pending = new Set(plan.actions
    .filter((action) => action.kind === 'create' || action.kind === 'enable' || action.kind === 'disable' || action.kind === 'profile')
    .map((action) => action.serviceId));
  const sessions = new Map(active.map((session) => [session.name, session]));

  const info = new Map((db.prepare(`
    SELECT s.id AS serviceId, s.status AS status, p.name AS planName
    FROM services s LEFT JOIN internet_plans p ON p.id = s.plan_id
  `).all() as Array<{ serviceId: number; status: string; planName: string | null }>).map((row) => [row.serviceId, row]));

  const plansByProfile = new Map<string, Array<{ id: number; name: string }>>();
  for (const row of db.prepare(`
    SELECT id, name, TRIM(router_profile) AS profile FROM internet_plans
    WHERE active = 1 AND router_profile IS NOT NULL AND TRIM(router_profile) <> '' ORDER BY name
  `).all() as Array<{ id: number; name: string; profile: string }>) {
    plansByProfile.set(row.profile, [...(plansByProfile.get(row.profile) ?? []), { id: row.id, name: row.name }]);
  }

  const rows: ReconRow[] = [];
  const claimed = new Set<string>();

  for (const service of desired) {
    const secret = plan.matched.get(service.serviceId);
    const status = info.get(service.serviceId);
    const base = {
      serviceId: service.serviceId,
      clientName: service.clientName,
      held: !pending.has(service.serviceId),
      managed: true,
      planOptions: []
    };

    if (!secret) {
      rows.push({
        ...base, key: `only_ispm:${service.serviceId}`, kind: 'only_ispm', secretId: null,
        login: service.username, ispm: `Utilizador ${service.username}`, router: 'Não existe', online: false
      });
      continue;
    }
    claimed.add(secret.id);
    const online = sessions.has(secret.name);
    const routerAccess = routerGivesAccess(secret, suspendedProfile);

    if (ispmGivesAccess(service) !== routerAccess) {
      rows.push({
        ...base, key: `state:${service.serviceId}`, kind: 'state', secretId: secret.id, login: secret.name, online,
        ispm: STATUS_LABEL[status?.status ?? ''] ?? status?.status ?? '—',
        router: routerAccess
          ? `Com serviço (${secret.profile ?? 'perfil por omissão'})`
          : secret.disabled ? 'Desativado' : `Suspenso (${secret.profile})`
      });
    } else if (routerAccess && service.profile && secret.profile !== service.profile) {
      rows.push({
        ...base, key: `plan:${service.serviceId}`, kind: 'plan', secretId: secret.id, login: secret.name, online,
        ispm: `${status?.planName ?? 'Sem plano'} · ${service.profile}`,
        router: secret.profile ?? 'perfil por omissão',
        planOptions: secret.profile ? plansByProfile.get(secret.profile) ?? [] : []
      });
    }
  }

  for (const secret of secrets) {
    if (claimed.has(secret.id)) continue;
    rows.push({
      key: `only_router:${secret.id}`, kind: 'only_router', serviceId: null, secretId: secret.id, clientName: null,
      login: secret.name, ispm: 'Não existe',
      router: `${secret.disabled ? 'Desativado' : 'Ativo'} · ${secret.profile ?? 'perfil por omissão'}`,
      held: true, managed: Boolean(secret.comment?.startsWith('ispm:')), online: sessions.has(secret.name), planOptions: []
    });
  }

  const unlinkedServices = db.prepare(`
    SELECT s.id AS serviceId, c.full_name AS clientName, c.client_code AS clientCode
    FROM services s JOIN clients c ON c.id = s.client_id
    WHERE (s.pppoe_username IS NULL OR TRIM(s.pppoe_username) = '') AND s.status <> 'cancelled'
    ORDER BY c.full_name
  `).all() as Reconciliation['unlinkedServices'];

  return {
    rows,
    unlinkedServices,
    context: {
      suspendedProfile,
      desired: new Map(desired.map((service) => [service.serviceId, service])),
      secrets: new Map(secrets.map((secret) => [secret.id, secret])),
      sessions
    }
  };
}

export function buildReconciliation(db: Database.Database, secrets: RouterSecret[], active: RouterActive[]): Reconciliation {
  const { rows, unlinkedServices } = build(db, secrets, active);
  return { rows, unlinkedServices };
}

// ------------------------------------------------------------------ resolução

export type ResolveItem = {
  key: string;
  /** `ispm`: o valor do ISPM vai para o router. `router`: o do router vem para o ISPM. */
  direction: 'ispm' | 'router';
  /** Importar um plano quando mais do que um usa o mesmo perfil. */
  planId?: number;
  /** Associar um secret só do router a este serviço. */
  targetServiceId?: number;
  /** Desativar um secret feito à mão exige escrever o nome dele. */
  confirmName?: string;
};

export type ResolveResult = {
  key: string;
  status: 'applied' | 'failed' | 'dry_run' | 'not_processed';
  message: string;
};

export type ResolveDeps = {
  transport: RouterTransport;
  dryRun: boolean;
  maxDisables: number;
  /** Pausa entre itens: o router é pequeno e isto nunca tem pressa. */
  pauseMs?: number;
};

type AuditRequest = Parameters<typeof recordAuditStrict>[1];

const PAUSE_MS = 250;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** O que a resolução faz, por palavras: é a mensagem do resultado e o resumo da auditoria. */
function describe(row: ReconRow, item: ResolveItem): string {
  const who = row.clientName ? `${row.clientName} (${row.login})` : row.login;
  if (item.direction === 'ispm') {
    if (row.kind === 'plan') return `Repôs no router o perfil do plano de ${who}`;
    if (row.kind === 'state') return `Impôs no router o estado do ISPM a ${who}`;
    if (row.kind === 'only_ispm') return `Criou no router o utilizador PPPoE de ${who}`;
    return `Desativou no router o utilizador ${row.login}, que não tem serviço no ISPM`;
  }
  if (row.kind === 'plan') return `Trouxe do router o plano de ${who} (perfil ${row.router}); a mensalidade não mudou`;
  if (row.kind === 'state') return `Trouxe do router o estado de ${who}: ${row.router}`;
  if (row.kind === 'only_ispm') return `Tirou o utilizador PPPoE do serviço de ${who}, que já não existe no router`;
  return `Associou o utilizador ${row.login} do router a um serviço do ISPM`;
}

/** O que o ISPM pede passa a ser o acordo: o que ainda diferir no router é desvio, e fica retido. */
function confirmIntent(db: Database.Database, serviceId: number, secret: RouterSecret, suspendedProfile: string): void {
  const service = loadDesiredServices(db, { suspendedProfile }).find((item) => item.serviceId === serviceId);
  if (!service) return;
  db.prepare(`
    INSERT INTO service_network_state (
      service_id, secret_id, desired_enabled, confirmed_secret_id, confirmed_username, confirmed_profile, confirmed_enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(service_id) DO UPDATE SET
      confirmed_secret_id = excluded.confirmed_secret_id,
      confirmed_username = excluded.confirmed_username,
      confirmed_profile = excluded.confirmed_profile,
      confirmed_enabled = excluded.confirmed_enabled
  `).run(serviceId, secret.id, service.enabled ? 1 : 0, secret.id, service.username, service.profile, service.enabled ? 1 : 0);
}

/** Uma passagem só deste serviço, depois de esquecido o acordo que retinha a diferença. */
async function pushService(db: Database.Database, deps: ResolveDeps, serviceId: number, forget: string): Promise<void> {
  db.prepare(`UPDATE service_network_state SET ${forget} WHERE service_id = ?`).run(serviceId);
  const summary = await runNetworkEnforcement(db, {
    transport: deps.transport,
    dryRun: false,
    maxDisables: deps.maxDisables,
    serviceIds: [serviceId],
    reportOrphans: false
  });
  if (summary.aborted) throw new Error(summary.reason ?? 'Passagem abortada');
  const state = db.prepare('SELECT last_error AS lastError FROM service_network_state WHERE service_id = ?').get(serviceId) as
    | { lastError: string | null }
    | undefined;
  if (state?.lastError) throw new Error(state.lastError);
}

async function applyIspm(db: Database.Database, deps: ResolveDeps, row: ReconRow, item: ResolveItem, context: Context): Promise<void> {
  if (row.kind === 'plan') return pushService(db, deps, row.serviceId!, 'confirmed_profile = NULL');
  // O estado pode estar no `disabled` ou no perfil de suspensão: esquecem-se os dois.
  if (row.kind === 'state') return pushService(db, deps, row.serviceId!, 'confirmed_profile = NULL, confirmed_enabled = NULL');
  if (row.kind === 'only_ispm') return pushService(db, deps, row.serviceId!, 'confirmed_secret_id = NULL');

  // Só no router. Nunca se apaga: desativar desfaz-se com um clique no Winbox.
  if (!row.managed && item.confirmName !== row.login) {
    throw new Error(`Este utilizador foi criado à mão no router. Escreva "${row.login}" para confirmar que o quer desativar.`);
  }
  const secret = context.secrets.get(row.secretId!)!;
  if (!secret.disabled) await patchSecret(deps.transport, secret.id, { disabled: true });
  const session = context.sessions.get(secret.name);
  if (session) await removeActive(deps.transport, session.id);
}

function importRouter(db: Database.Database, request: AuditRequest, row: ReconRow, item: ResolveItem, context: Context, summary: string): void {
  const audit = (serviceId: number, extra: Record<string, unknown> = {}) => recordAuditStrict(db, request, {
    action: 'reconciliation_import',
    entityType: 'service',
    entityId: serviceId,
    summary,
    metadata: { kind: row.kind, direction: 'router', login: row.login, ispm: row.ispm, router: row.router, ...extra }
  });

  db.transaction(() => {
    if (row.kind === 'only_ispm') {
      db.prepare(`
        UPDATE services
        SET pppoe_username = NULL, pppoe_password = NULL, pppoe_password_sync_pending = 0, updated_at = datetime('now')
        WHERE id = ?
      `).run(row.serviceId);
      db.prepare('DELETE FROM service_network_state WHERE service_id = ?').run(row.serviceId);
      audit(row.serviceId!);
      return;
    }

    const secret = context.secrets.get(row.secretId!)!;

    if (row.kind === 'only_router') {
      if (!item.targetServiceId) throw new Error('Escolha o serviço a que este utilizador pertence');
      const target = db.prepare('SELECT pppoe_username AS username FROM services WHERE id = ?').get(item.targetServiceId) as
        | { username: string | null }
        | undefined;
      if (!target) throw new Error('Serviço não encontrado');
      if (target.username?.trim()) throw new Error('Esse serviço já tem utilizador PPPoE');
      if (db.prepare('SELECT 1 FROM services WHERE pppoe_username = ?').get(secret.name)) {
        throw new Error(`Já há um serviço com o utilizador ${secret.name}`);
      }
      db.prepare(`UPDATE services SET pppoe_username = ?, updated_at = datetime('now') WHERE id = ?`).run(secret.name, item.targetServiceId);
      confirmIntent(db, item.targetServiceId, secret, context.suspendedProfile);
      audit(item.targetServiceId);
      return;
    }

    if (row.kind === 'plan') {
      const chosen = item.planId
        ? row.planOptions.find((plan) => plan.id === item.planId)
        : row.planOptions.length === 1 ? row.planOptions[0] : undefined;
      if (!chosen) {
        throw new Error(row.planOptions.length
          ? `Mais do que um plano usa o perfil ${row.router}: escolha qual`
          : `Nenhum plano do ISPM usa o perfil ${row.router}`);
      }
      const before = db.prepare('SELECT plan_id AS planId FROM services WHERE id = ?').get(row.serviceId) as { planId: number | null };
      db.prepare(`UPDATE services SET plan_id = ?, updated_at = datetime('now') WHERE id = ?`).run(chosen.id, row.serviceId);
      audit(row.serviceId!, { fromPlanId: before.planId, toPlanId: chosen.id, toPlan: chosen.name });
    } else {
      const next = routerGivesAccess(secret, context.suspendedProfile) ? 'active' : 'suspended';
      const changed = changeServiceStatus(db, row.serviceId!, next, {
        reason: 'Importado do router na reconciliação',
        actorId: request.user?.id ?? null,
        source: next === 'suspended' ? 'manual' : null
      });
      if (!changed.ok) throw new Error(changed.error);
      audit(row.serviceId!, { status: next });
    }
    confirmIntent(db, row.serviceId!, secret, context.suspendedProfile);
  })();
}

/**
 * Resolve as divergências pedidas, uma de cada vez. Cada item é conferido
 * contra o que o router tem **agora**, não contra o que o ecrã mostrava. Se o
 * router deixar de responder, pára: os restantes ficam por processar.
 */
export async function resolveReconciliation(
  db: Database.Database,
  deps: ResolveDeps,
  request: AuditRequest,
  items: ResolveItem[],
  router: { secrets: RouterSecret[]; active: RouterActive[] }
): Promise<ResolveResult[]> {
  const { rows, context } = build(db, router.secrets, router.active);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const results: ResolveResult[] = [];
  let unreachable: string | null = null;

  for (const [index, item] of items.entries()) {
    const row = byKey.get(item.key);
    if (unreachable) {
      results.push({ key: item.key, status: 'not_processed', message: `Por processar: ${unreachable}` });
      continue;
    }
    if (!row) {
      results.push({ key: item.key, status: 'failed', message: 'Esta divergência já não existe: atualize a lista' });
      continue;
    }
    const summary = describe(row, item);
    if (deps.dryRun) {
      results.push({ key: item.key, status: 'dry_run', message: `Ensaio — nada foi alterado. ${summary}` });
      continue;
    }
    try {
      if (item.direction === 'router') {
        importRouter(db, request, row, item, context, summary);
      } else {
        if (index > 0) await delay(deps.pauseMs ?? PAUSE_MS);
        await applyIspm(db, deps, row, item, context);
        try {
          recordAuditStrict(db, request, {
            action: 'reconciliation_apply',
            entityType: row.serviceId ? 'service' : 'router',
            entityId: row.serviceId ?? row.login,
            summary,
            metadata: { kind: row.kind, direction: 'ispm', login: row.login, ispm: row.ispm, router: row.router }
          });
        } catch {
          // A auditoria não pode fazer falhar o que já aconteceu no router.
        }
      }
      results.push({ key: item.key, status: 'applied', message: summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: item.key, status: 'failed', message });
      // status 0 = não chegou resposta nenhuma. Continuar era escrever às cegas.
      if (err instanceof RouterError && err.status === 0) unreachable = message;
    }
  }
  return results;
}
