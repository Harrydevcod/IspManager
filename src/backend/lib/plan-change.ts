import type Database from 'better-sqlite3';
import { recordAuditStrict } from './audit';
import { loadDesiredServices, matchSecrets } from './network-enforcement';
import { readSuspendedProfileName } from './plan-profiles';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import {
  createTransport, isRouterConfigured, listActive, listSecrets, patchSecret, readRouterConfig, removeActive, RouterError,
  type RouterActive, type RouterSecret, type RouterTransport
} from './routeros';

/**
 * Mudança de plano em massa (ADR 0014).
 *
 * A base e o router não partilham transação, por isso cada serviço passa por
 * três tempos: escreve-se o plano novo na base com o item `pending`, chama-se o
 * router, e só então o item fica `applied` — ou a base volta atrás e o item
 * fica `failed`, com o erro. Um serviço de cada vez, com pausa entre chamadas:
 * o router é pequeno e uma mudança de plano nunca tem pressa.
 *
 * Um erro do router num serviço não pára os outros; o router deixar de
 * responder pára tudo, e o que faltava fica `not_processed` — nunca se continua
 * às cegas. Repetir a mesma operação não faz nada: quem já está no plano e no
 * perfil de destino fica `unchanged`, sem uma única chamada.
 */

export type RouterSnapshot = { secrets: RouterSecret[]; active: RouterActive[]; profiles: string[] };

export type PlanChangeInput = { serviceIds: number[]; targetPlanId: number; updatePrice: boolean };

export type PreviewOutcome =
  /** Muda na base e, se for o caso, no router. */
  | 'change'
  | 'unchanged'
  /** Suspenso: muda o plano no ISPM; o router fica no perfil de suspensão. */
  | 'suspended'
  /** Tem utilizador PPPoE mas o router não tem o secret: só muda no ISPM. */
  | 'no_secret'
  /** Sem utilizador PPPoE: não está no controlo de acesso, só muda no ISPM. */
  | 'no_pppoe'
  /** Cancelado: fica de fora. */
  | 'cancelled';

export type PreviewRow = {
  serviceId: number;
  clientName: string;
  clientCode: string;
  status: string;
  login: string | null;
  fromPlanId: number | null;
  fromPlanName: string | null;
  fromValueCve: number;
  toValueCve: number;
  /** Renda do equipamento do ISP: soma-se à mensalidade nos dois lados. */
  rentalCve: number;
  fromProfile: string | null;
  toProfile: string | null;
  online: boolean;
  /** O perfil do secret vai mudar — é o que faz a sessão ter de renegociar. */
  routerChange: boolean;
  outcome: PreviewOutcome;
};

export type PlanChangePreview = {
  targetPlan: { id: number; name: string; monthlyPriceCve: number; routerProfile: string | null } | null;
  rows: PreviewRow[];
  /** Quantos mudam, por plano de origem. */
  groups: Array<{ planName: string; count: number }>;
  toChange: number;
  /** Sessões ativas cujo perfil muda: só apanham a velocidade nova ao reconectar. */
  sessionsOnline: number;
  /** O que impede a execução; vazio = pode avançar. */
  blockers: string[];
  dryRun: boolean;
};

type ServiceRow = {
  serviceId: number;
  clientName: string;
  clientCode: string;
  status: string;
  login: string | null;
  planId: number | null;
  planName: string | null;
  valueCve: number;
  rentalCve: number;
};

type TargetPlan = NonNullable<PlanChangePreview['targetPlan']> & { active: number };

function loadTargetPlan(db: Database.Database, planId: number): TargetPlan | undefined {
  return db.prepare(`
    SELECT id, name, monthly_price_cve AS monthlyPriceCve, NULLIF(TRIM(router_profile), '') AS routerProfile, active
    FROM internet_plans WHERE id = ?
  `).get(planId) as TargetPlan | undefined;
}

function loadServices(db: Database.Database, serviceIds: number[]): ServiceRow[] {
  if (serviceIds.length === 0) return [];
  return db.prepare(`
    SELECT s.id AS serviceId, c.full_name AS clientName, c.client_code AS clientCode, s.status AS status,
      NULLIF(TRIM(s.pppoe_username), '') AS login, s.plan_id AS planId, p.name AS planName,
      s.monthly_value_cve AS valueCve,
      COALESCE((
        SELECT SUM(a.rental_fee_cve) FROM service_device_assignments a
        WHERE a.service_id = s.id AND a.end_date IS NULL AND a.ownership = 'isp'
      ), 0) AS rentalCve
    FROM services s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    WHERE s.id IN (${serviceIds.map(() => '?').join(',')})
    ORDER BY c.full_name, s.id
  `).all(...serviceIds) as ServiceRow[];
}

/** Serviço → secret no router, pela mesma âncora da reconciliação. */
function secretFinder(db: Database.Database, secrets: RouterSecret[]): (serviceId: number) => RouterSecret | undefined {
  const matched = matchSecrets(loadDesiredServices(db), secrets);
  return (serviceId) => matched.get(serviceId);
}

const CHANGING: ReadonlySet<PreviewOutcome> = new Set(['change', 'suspended', 'no_secret', 'no_pppoe']);

/**
 * O que a operação faria, sem escrever nada. `router` nulo = não foi possível
 * lê-lo; `routerIssue` diz porquê e passa a ser um bloqueio.
 */
export function previewPlanChange(
  db: Database.Database,
  input: PlanChangeInput,
  router: RouterSnapshot | null,
  context: { dryRun: boolean; routerIssue?: string }
): PlanChangePreview {
  const target = loadTargetPlan(db, input.targetPlanId);
  const suspendedProfile = readSuspendedProfileName(db);
  const online = new Set((router?.active ?? []).map((session) => session.name));
  const blockers: string[] = [];
  const secretOf = router ? secretFinder(db, router.secrets) : () => undefined;

  const rows: PreviewRow[] = !target ? [] : loadServices(db, input.serviceIds).map((service) => {
    const toValueCve = input.updatePrice ? target.monthlyPriceCve : service.valueCve;
    const dbChange = service.planId !== target.id || service.valueCve !== toValueCve;
    const secret = secretOf(service.serviceId);
    const suspended = service.status === 'suspended';
    const toProfile = suspended && suspendedProfile ? suspendedProfile : target.routerProfile;
    const routerChange = Boolean(secret && !suspended && service.status === 'active' && secret.profile !== target.routerProfile);

    let outcome: PreviewOutcome;
    if (service.status === 'cancelled') outcome = 'cancelled';
    else if (!service.login) outcome = dbChange ? 'no_pppoe' : 'unchanged';
    else if (suspended) outcome = dbChange ? 'suspended' : 'unchanged';
    // Sem leitura do router não se sabe se o secret existe: não se afirma que falta.
    else if (!secret && router) outcome = dbChange ? 'no_secret' : 'unchanged';
    else outcome = dbChange || routerChange ? 'change' : 'unchanged';

    return {
      serviceId: service.serviceId,
      clientName: service.clientName,
      clientCode: service.clientCode,
      status: service.status,
      login: secret?.name ?? service.login,
      fromPlanId: service.planId,
      fromPlanName: service.planName,
      fromValueCve: service.valueCve,
      toValueCve,
      rentalCve: service.rentalCve,
      fromProfile: secret?.profile ?? null,
      toProfile,
      online: Boolean(secret && online.has(secret.name)),
      routerChange,
      outcome
    };
  });

  const changing = rows.filter((row) => CHANGING.has(row.outcome));
  const groupCount = new Map<string, number>();
  for (const row of changing) {
    const name = row.fromPlanName ?? 'Sem plano';
    groupCount.set(name, (groupCount.get(name) ?? 0) + 1);
  }

  if (!target) blockers.push('O plano de destino não existe.');
  else {
    if (!target.active) blockers.push(`O plano ${target.name} está inativo.`);
    if (!target.routerProfile) blockers.push(`O plano ${target.name} não tem perfil PPP definido.`);
    else if (router && !router.profiles.includes(target.routerProfile)) {
      blockers.push(`O perfil ${target.routerProfile} do plano ${target.name} não existe no router. Crie-o ou sincronize os planos antes de mudar clientes para ele.`);
    }
    if (changing.length === 0) blockers.push('Nenhum dos serviços escolhidos muda: já estão todos neste plano.');
  }
  if (!router) blockers.push(context.routerIssue ?? 'Não foi possível ler o router.');
  if (db.prepare(`SELECT 1 FROM plan_change_batches WHERE status = 'running'`).get()) {
    blockers.push('Já há uma mudança de plano em curso. Espere que acabe ou cancele-a.');
  }

  return {
    targetPlan: target ? { id: target.id, name: target.name, monthlyPriceCve: target.monthlyPriceCve, routerProfile: target.routerProfile } : null,
    rows,
    groups: [...groupCount].map(([planName, count]) => ({ planName, count })).sort((a, b) => b.count - a.count),
    toChange: changing.length,
    sessionsOnline: rows.filter((row) => row.outcome === 'change' && row.routerChange && row.online).length,
    blockers,
    dryRun: context.dryRun
  };
}

// --------------------------------------------------------------------- lote

export type DropMode = 'none' | 'now' | 'scheduled';
export type BatchStatus = 'running' | 'done' | 'cancelled' | 'stopped';
export type ItemStatus = 'queued' | 'pending' | 'applied' | 'unchanged' | 'failed' | 'not_processed';

export type PlanChangeOptions = PlanChangeInput & {
  reason?: string | null;
  dropMode: DropMode;
  /** Instante (ISO) em que as sessões são derrubadas, com `dropMode: 'scheduled'`. */
  dropAt?: string | null;
};

type AuditRequest = Parameters<typeof recordAuditStrict>[1];

export class PlanChangeBlocked extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join(' '));
  }
}

/** UTC no formato do `datetime('now')` do SQLite. */
function sqlTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function fromSqlTime(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/**
 * Valida outra vez — contra o router lido agora — e grava o lote com um item
 * por serviço. Lança `PlanChangeBlocked` se alguma coisa impedir a execução:
 * um plano que não existe no router recusa-se aqui, antes da primeira escrita.
 */
export function createPlanChangeBatch(
  db: Database.Database,
  options: PlanChangeOptions,
  router: RouterSnapshot,
  context: { dryRun: boolean; actor: AuditRequest; now?: Date }
): number {
  const preview = previewPlanChange(db, options, router, { dryRun: context.dryRun });
  const blockers = [...preview.blockers];
  const now = context.now ?? new Date();
  let dropAt: string | null = null;
  if (options.dropMode === 'scheduled') {
    const at = options.dropAt ? new Date(options.dropAt) : null;
    if (!at || Number.isNaN(at.getTime())) blockers.push('Indique a hora a que as sessões devem ser derrubadas.');
    else if (at.getTime() <= now.getTime()) blockers.push('A hora para derrubar as sessões já passou.');
    else if (at.getTime() - now.getTime() > 7 * 86_400_000) blockers.push('A hora para derrubar as sessões não pode ficar a mais de 7 dias.');
    else dropAt = sqlTime(at);
  }
  if (blockers.length || !preview.targetPlan) throw new PlanChangeBlocked(blockers);

  const target = preview.targetPlan;
  const user = context.actor.user;
  return db.transaction(() => {
    const batchId = Number(db.prepare(`
      INSERT INTO plan_change_batches (
        target_plan_id, target_plan_name, reason, update_price, drop_mode, drop_at, dry_run,
        created_by, created_by_name, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      target.id, target.name, options.reason?.trim() || null, options.updatePrice ? 1 : 0, options.dropMode, dropAt,
      context.dryRun ? 1 : 0, user?.id ?? null, user?.username ?? null, sqlTime(now)
    ).lastInsertRowid);

    const insert = db.prepare(`
      INSERT INTO plan_change_items (
        batch_id, service_id, client_name, login, from_plan_id, from_plan_name,
        from_value_cve, to_value_cve, from_profile, to_profile, was_online
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of preview.rows) {
      if (row.outcome === 'cancelled') continue;
      insert.run(batchId, row.serviceId, row.clientName, row.login, row.fromPlanId, row.fromPlanName,
        row.fromValueCve, row.toValueCve, row.fromProfile, row.toProfile, row.online ? 1 : 0);
    }
    return batchId;
  })();
}

export type PlanChangeDeps = {
  transport: RouterTransport;
  dryRun: boolean;
  /** Pausa depois de cada chamada que escreve no router. */
  pauseMs?: number;
  now?: () => Date;
};

const PAUSE_MS = 250;
const delay = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const unreachable = (err: unknown) => err instanceof RouterError && err.status === 0;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

type ItemRow = {
  id: number;
  serviceId: number;
  clientName: string;
  fromPlanName: string | null;
};

type ItemOutcome = {
  status: Extract<ItemStatus, 'applied' | 'unchanged' | 'failed'>;
  note?: string;
  error?: string;
  routerChanged?: boolean;
  droppedAt?: string;
  /** O router deixou de responder: o lote pára depois deste item. */
  lost?: string;
};

/**
 * Corre o lote até ao fim, a um cancelamento ou ao router deixar de responder.
 * `router` é a leitura feita na validação: uma só para o lote inteiro.
 */
export async function runPlanChangeBatch(
  db: Database.Database,
  deps: PlanChangeDeps,
  batchId: number,
  router: RouterSnapshot,
  actor: AuditRequest
): Promise<BatchStatus> {
  const batch = db.prepare(`
    SELECT target_plan_id AS targetPlanId, update_price AS updatePrice, drop_mode AS dropMode
    FROM plan_change_batches WHERE id = ? AND status = 'running'
  `).get(batchId) as { targetPlanId: number; updatePrice: number; dropMode: DropMode } | undefined;
  if (!batch) return 'stopped';

  const now = deps.now ?? (() => new Date());
  const pause = () => delay(deps.pauseMs ?? PAUSE_MS);
  const sessions = new Map(router.active.map((session) => [session.name, session]));
  const items = db.prepare(`
    SELECT id, service_id AS serviceId, client_name AS clientName, from_plan_name AS fromPlanName
    FROM plan_change_items WHERE batch_id = ? AND status = 'queued' ORDER BY id
  `).all(batchId) as ItemRow[];

  const finish = (status: BatchStatus, reason: string | null): BatchStatus => {
    db.transaction(() => {
      db.prepare(`UPDATE plan_change_items SET status = 'not_processed' WHERE batch_id = ? AND status = 'queued'`).run(batchId);
      db.prepare(`
        UPDATE plan_change_batches
        SET status = ?, stop_reason = ?, finished_at = ?,
          drop_status = CASE
            WHEN drop_mode = 'scheduled' AND EXISTS (
              SELECT 1 FROM plan_change_items WHERE batch_id = plan_change_batches.id AND router_changed = 1
            ) THEN 'pending'
          END
        WHERE id = ?
      `).run(status, reason, sqlTime(now()), batchId);
    })();
    const counts = planChangeCounts(db, batchId);
    try {
      recordAuditStrict(db, actor, {
        action: 'plan_change_batch',
        entityType: 'internet_plan',
        entityId: batch.targetPlanId,
        summary: `Mudança de plano em massa #${batchId}: ${counts.applied} aplicados, ${counts.failed} falhados, ${counts.not_processed} por processar`,
        metadata: { batchId, status, reason, counts, dryRun: deps.dryRun }
      });
    } catch {
      // O lote já aconteceu; a auditoria não o desfaz.
    }
    return status;
  };

  const target = loadTargetPlan(db, batch.targetPlanId);
  if (!target?.routerProfile) return finish('stopped', 'O plano de destino deixou de existir ou ficou sem perfil PPP.');
  const targetProfile = target.routerProfile;
  const secretOf = secretFinder(db, router.secrets);

  const processItem = async (item: ItemRow): Promise<ItemOutcome> => {
    const service = db.prepare(`
      SELECT plan_id AS planId, status, NULLIF(TRIM(pppoe_username), '') AS login, monthly_value_cve AS valueCve
      FROM services WHERE id = ?
    `).get(item.serviceId) as { planId: number | null; status: string; login: string | null; valueCve: number } | undefined;
    if (!service) return { status: 'failed', error: 'O serviço já não existe.' };
    if (service.status === 'cancelled') return { status: 'unchanged', note: 'Serviço cancelado: não foi alterado.' };

    const toValueCve = batch.updatePrice ? target.monthlyPriceCve : service.valueCve;
    const dbChange = service.planId !== target.id || service.valueCve !== toValueCve;
    const secret = service.login ? secretOf(item.serviceId) : undefined;
    // Só um serviço ativo tem o perfil do plano no router. Um suspenso está no
    // perfil de suspensão e é lá que fica: mudar-lho era reativá-lo por engano.
    const routerChange = Boolean(!deps.dryRun && secret && service.status === 'active' && secret.profile !== targetProfile);
    if (!dbChange && !routerChange) return { status: 'unchanged' };

    // 1. A intenção na base, com o item por confirmar.
    db.transaction(() => {
      db.prepare(`UPDATE services SET plan_id = ?, monthly_value_cve = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(target.id, toValueCve, item.serviceId);
      db.prepare(`UPDATE plan_change_items SET status = 'pending', to_value_cve = ? WHERE id = ?`).run(toValueCve, item.id);
    })();

    if (!routerChange || !secret) {
      return {
        status: 'applied',
        note: deps.dryRun && secret && service.status === 'active' ? 'Ensaio: mudou no ISPM, o router não foi alterado.'
          : service.status === 'suspended' ? 'Suspenso: mudou no ISPM; no router continua no perfil de suspensão.'
          : !service.login ? 'Sem utilizador PPPoE: só mudou no ISPM.'
          : !secret ? 'O router não tem este utilizador PPPoE: só mudou no ISPM.'
          : undefined
      };
    }

    // 2. O router.
    try {
      await patchSecret(deps.transport, secret.id, { profile: targetProfile });
    } catch (err) {
      // 4. Falhou: a base volta ao que era, e o erro fica no item.
      db.prepare(`UPDATE services SET plan_id = ?, monthly_value_cve = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(service.planId, service.valueCve, item.serviceId);
      return { status: 'failed', error: messageOf(err), ...(unreachable(err) ? { lost: messageOf(err) } : {}) };
    }

    // 3. Confirmado: o perfil novo passa a ser o acordo, para a reconciliação
    // não o ver como desvio nem voltar a escrevê-lo.
    secret.profile = targetProfile;
    db.prepare(`UPDATE service_network_state SET profile = ?, confirmed_profile = ? WHERE service_id = ?`)
      .run(targetProfile, targetProfile, item.serviceId);
    await pause();

    const session = sessions.get(secret.name);
    if (batch.dropMode !== 'now' || !session) return { status: 'applied', routerChanged: true };
    try {
      await removeActive(deps.transport, session.id);
      sessions.delete(secret.name);
      await pause();
      return { status: 'applied', routerChanged: true, droppedAt: sqlTime(now()) };
    } catch (err) {
      return {
        status: 'applied',
        routerChanged: true,
        note: `O plano mudou, mas a sessão não foi derrubada: ${messageOf(err)}`,
        ...(unreachable(err) ? { lost: messageOf(err) } : {})
      };
    }
  };

  for (const item of items) {
    const cancelled = db.prepare('SELECT cancel_requested AS flag FROM plan_change_batches WHERE id = ?').get(batchId) as { flag: number };
    if (cancelled.flag) return finish('cancelled', 'Cancelado pelo operador.');

    let outcome: ItemOutcome;
    try {
      outcome = await processItem(item);
    } catch (err) {
      outcome = { status: 'failed', error: messageOf(err) };
    }
    db.prepare(`
      UPDATE plan_change_items
      SET status = ?, note = ?, error = ?, router_changed = ?, session_dropped_at = ?, processed_at = ?
      WHERE id = ?
    `).run(outcome.status, outcome.note ?? null, outcome.error ?? null, outcome.routerChanged ? 1 : 0, outcome.droppedAt ?? null, sqlTime(now()), item.id);

    if (outcome.status !== 'unchanged') {
      try {
        recordAuditStrict(db, actor, {
          action: 'plan_change',
          entityType: 'service',
          entityId: item.serviceId,
          summary: outcome.status === 'applied'
            ? `${item.clientName} passou do plano ${item.fromPlanName ?? 'nenhum'} para ${target.name}`
            : `Falhou a mudança de ${item.clientName} para o plano ${target.name}: ${outcome.error}`,
          metadata: {
            batchId, fromPlan: item.fromPlanName, toPlan: target.name, result: outcome.status,
            sessionDropped: Boolean(outcome.droppedAt), routerChanged: Boolean(outcome.routerChanged),
            note: outcome.note ?? null, error: outcome.error ?? null
          }
        });
      } catch {
        // A mudança já aconteceu; a auditoria não a desfaz.
      }
    }
    if (outcome.lost) return finish('stopped', `O router deixou de responder: ${outcome.lost}`);
  }
  return finish('done', null);
}

/** Pede para parar um lote em curso, ou desmarca as sessões agendadas de um lote já acabado. */
export function cancelPlanChange(db: Database.Database, batchId: number): 'cancelling' | 'drop_cancelled' | 'nothing' | 'not_found' {
  const batch = db.prepare('SELECT status, drop_status AS dropStatus FROM plan_change_batches WHERE id = ?').get(batchId) as
    | { status: BatchStatus; dropStatus: string | null }
    | undefined;
  if (!batch) return 'not_found';
  if (batch.status === 'running') {
    db.prepare('UPDATE plan_change_batches SET cancel_requested = 1 WHERE id = ?').run(batchId);
    return 'cancelling';
  }
  if (batch.dropStatus === 'pending') {
    db.prepare(`UPDATE plan_change_batches SET drop_status = 'cancelled' WHERE id = ?`).run(batchId);
    return 'drop_cancelled';
  }
  return 'nothing';
}

/**
 * No arranque: um lote que ficou `running` foi interrompido por o ISPM fechar.
 * O item apanhado a meio tem o plano novo na base e o router por confirmar — a
 * passagem automática acerta-o, porque para ela é uma intenção nova.
 */
export function recoverInterruptedPlanChanges(db: Database.Database): number {
  const batches = db.prepare(`SELECT id FROM plan_change_batches WHERE status = 'running'`).all() as Array<{ id: number }>;
  db.transaction(() => {
    for (const { id } of batches) {
      db.prepare(`
        UPDATE plan_change_items
        SET status = 'applied', note = 'O ISPM fechou a meio: a passagem automática acerta o router.', processed_at = datetime('now')
        WHERE batch_id = ? AND status = 'pending'
      `).run(id);
      db.prepare(`UPDATE plan_change_items SET status = 'not_processed' WHERE batch_id = ? AND status = 'queued'`).run(id);
      db.prepare(`
        UPDATE plan_change_batches
        SET status = 'stopped', stop_reason = 'O ISPM foi fechado a meio da operação.', finished_at = datetime('now')
        WHERE id = ?
      `).run(id);
    }
  })();
  return batches.length;
}

// ------------------------------------------------------- sessões agendadas

const DROP_GRACE_MS = 60 * 60_000;
const UPTIME_UNIT: Record<string, number> = { w: 604_800, d: 86_400, h: 3600, m: 60, s: 1 };

/** "1w2d3h4m5s" em segundos; null se o router escrever outra coisa. */
export function uptimeSeconds(uptime: string | null): number | null {
  if (!uptime) return null;
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of uptime.matchAll(/(\d+)([wdhms])/g)) {
    total += Number(amount) * UPTIME_UNIT[unit];
    matched = true;
  }
  return matched ? total : null;
}

export function hasDueSessionDrops(db: Database.Database, now = new Date()): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM plan_change_batches WHERE drop_status = 'pending' AND status <> 'running' AND drop_at <= ?
  `).get(sqlTime(now)));
}

/**
 * Derruba as sessões dos lotes cuja hora chegou — só as que já estavam abertas
 * quando o perfil mudou; quem reconectou entretanto já tem a velocidade nova.
 * Mais de uma hora atrasado (o PC esteve desligado) não derruba ninguém: as
 * 04:00 que o operador escolheu não são as 09:30 de um dia de trabalho.
 */
export async function runDueSessionDrops(
  db: Database.Database,
  deps: { transport: RouterTransport; pauseMs?: number; now?: () => Date },
  read: () => Promise<{ secrets: RouterSecret[]; active: RouterActive[] }>
): Promise<{ skipped?: true; dropped: number; expired: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const due = db.prepare(`
    SELECT id, drop_at AS dropAt FROM plan_change_batches
    WHERE drop_status = 'pending' AND status <> 'running' AND drop_at <= ? ORDER BY drop_at
  `).all(sqlTime(now)) as Array<{ id: number; dropAt: string }>;
  if (due.length === 0) return { skipped: true, dropped: 0, expired: 0 };

  const setStatus = db.prepare('UPDATE plan_change_batches SET drop_status = ? WHERE id = ?');
  let dropped = 0;
  let expired = 0;
  let router: Awaited<ReturnType<typeof read>> | null = null;

  for (const batch of due) {
    if (now.getTime() - fromSqlTime(batch.dropAt).getTime() > DROP_GRACE_MS) {
      setStatus.run('expired', batch.id);
      expired += 1;
      continue;
    }
    router ??= await read();
    const sessions = new Map(router.active.map((session) => [session.name, session]));
    const secretOf = secretFinder(db, router.secrets);
    const items = db.prepare(`
      SELECT i.id, i.service_id AS serviceId, i.processed_at AS processedAt, NULLIF(TRIM(s.pppoe_username), '') AS login
      FROM plan_change_items i JOIN services s ON s.id = i.service_id
      WHERE i.batch_id = ? AND i.status = 'applied' AND i.router_changed = 1 AND i.session_dropped_at IS NULL
      ORDER BY i.id
    `).all(batch.id) as Array<{ id: number; serviceId: number; processedAt: string; login: string | null }>;

    for (const item of items) {
      if (!item.login) continue;
      const name = secretOf(item.serviceId)?.name ?? item.login;
      const session = sessions.get(name);
      if (!session) continue;
      const age = uptimeSeconds(session.uptime);
      // Aberta depois da mudança = já renegociou com o perfil novo.
      if (age !== null && now.getTime() - age * 1000 > fromSqlTime(item.processedAt).getTime()) continue;
      await removeActive(deps.transport, session.id);
      sessions.delete(name);
      db.prepare('UPDATE plan_change_items SET session_dropped_at = ? WHERE id = ?').run(sqlTime(now), item.id);
      dropped += 1;
      await delay(deps.pauseMs ?? PAUSE_MS);
    }
    setStatus.run('done', batch.id);
  }
  return { dropped, expired };
}

/** O tick do agendador: só vai ao router se houver sessões com a hora chegada. */
export async function runScheduledSessionDrops(db: Database.Database): Promise<{ skipped?: true; reason?: string; dropped: number; expired: number }> {
  const config = readRouterConfig(db);
  const transport = createTransport(config);
  try {
    return await runDueSessionDrops(db, { transport }, async () => {
      if (!config.enabled || !isRouterConfigured(config) || config.dryRun) throw new Error('Router desligado, por configurar ou em ensaio');
      const presence = await detectAdminNetwork(db);
      if (isOffNetwork(presence)) throw new Error(offNetworkReason(presence));
      const secrets = await listSecrets(transport);
      const active = await listActive(transport);
      return { secrets, active };
    });
  } catch (err) {
    // Fica pendente: o tick seguinte volta a tentar, até a hora expirar.
    return { skipped: true, reason: messageOf(err), dropped: 0, expired: 0 };
  }
}

// ------------------------------------------------------------------ leitura

export type PlanChangeCounts = Record<ItemStatus, number>;

export function planChangeCounts(db: Database.Database, batchId: number): PlanChangeCounts {
  const counts: PlanChangeCounts = { queued: 0, pending: 0, applied: 0, unchanged: 0, failed: 0, not_processed: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM plan_change_items WHERE batch_id = ? GROUP BY status')
    .all(batchId) as Array<{ status: ItemStatus; n: number }>) {
    counts[row.status] = row.n;
  }
  return counts;
}

const BATCH_COLUMNS = `
  id, target_plan_id AS targetPlanId, target_plan_name AS targetPlanName, reason,
  update_price AS updatePrice, drop_mode AS dropMode, drop_at AS dropAt, drop_status AS dropStatus,
  dry_run AS dryRun, status, stop_reason AS stopReason, created_by_name AS createdByName,
  created_at AS createdAt, finished_at AS finishedAt
`;

export function listPlanChanges(db: Database.Database, limit = 50) {
  const batches = db.prepare(`SELECT ${BATCH_COLUMNS} FROM plan_change_batches ORDER BY id DESC LIMIT ?`).all(limit) as Array<{ id: number }>;
  return batches.map((batch) => ({ ...batch, counts: planChangeCounts(db, batch.id) }));
}

export function loadPlanChange(db: Database.Database, batchId: number) {
  const batch = db.prepare(`SELECT ${BATCH_COLUMNS} FROM plan_change_batches WHERE id = ?`).get(batchId) as { id: number } | undefined;
  if (!batch) return null;
  const items = db.prepare(`
    SELECT id, service_id AS serviceId, client_name AS clientName, login, from_plan_name AS fromPlanName,
      from_value_cve AS fromValueCve, to_value_cve AS toValueCve, from_profile AS fromProfile, to_profile AS toProfile,
      status, note, error, was_online AS wasOnline, router_changed AS routerChanged,
      session_dropped_at AS sessionDroppedAt, processed_at AS processedAt
    FROM plan_change_items WHERE batch_id = ? ORDER BY id
  `).all(batchId);
  return { ...batch, counts: planChangeCounts(db, batchId), items };
}
