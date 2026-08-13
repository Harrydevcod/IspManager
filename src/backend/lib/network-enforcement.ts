import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import {
  createSecret,
  createTransport,
  isRouterConfigured,
  listActive,
  listSecrets,
  patchSecret,
  readRouterConfig,
  removeActive,
  type RouterActive,
  type RouterSecret,
  type RouterTransport
} from './routeros';

/**
 * Reconciliação do acesso à rede (ADR 0007).
 *
 * A base de dados é a *intenção* — quem deve ter serviço — e o router é a
 * *realidade*. Este módulo compara as duas e aplica a diferença; nunca lê o
 * router para decidir o que deve acontecer. Uma divergência causada por alguém
 * a mexer no Winbox é reportada, não sobreposta em silêncio.
 *
 * O aprovisionamento cai do mesmo motor: um serviço com utilizador PPPoE na BD
 * e sem secret no router é apenas mais uma divergência ('missing_secret') que a
 * passagem seguinte resolve. Não há um segundo caminho de escrita a partir da
 * criação do serviço — nenhuma chamada de rede dentro de uma transação SQL.
 */

// A âncora do mapeamento. Sobrevive a alguém renomear o utilizador no router.
const COMMENT_PREFIX = 'ispm:';

export type DesiredService = {
  serviceId: number;
  clientName: string;
  username: string;
  password: string | null;
  /** Verdadeiro só para serviços ativos: suspenso e cancelado ficam desativados. */
  enabled: boolean;
  /** `<upload>M/<download>M`, ou null quando o plano não tem velocidade definida. */
  rateLimit: string | null;
};

export type PlannedAction =
  | { kind: 'create'; serviceId: number; username: string; rateLimit: string | null; clientName: string }
  | { kind: 'enable' | 'disable'; serviceId: number; username: string; secretId: string; clientName: string }
  | { kind: 'rate_limit'; serviceId: number; username: string; secretId: string; rateLimit: string; clientName: string };

export type Divergence = {
  serviceId: number | null;
  username: string;
  kind: 'missing_secret' | 'state' | 'rate_limit' | 'orphan_secret';
  detail: string;
};

export type EnforcementPlan = {
  actions: PlannedAction[];
  divergences: Divergence[];
  /** Serviço → secret encontrado no router. */
  matched: Map<number, RouterSecret>;
};

// ------------------------------------------------------------------ leitura

type ServiceRow = {
  serviceId: number;
  clientName: string;
  status: string;
  username: string;
  password: string | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
};

export function rateLimitFor(uploadMbps: number | null, downloadMbps: number | null): string | null {
  // Sem os dois números não se escreve velocidade nenhuma: um rate-limit
  // adivinhado a partir de texto livre estrangula quem paga.
  if (!uploadMbps || !downloadMbps || uploadMbps <= 0 || downloadMbps <= 0) return null;
  return `${uploadMbps}M/${downloadMbps}M`;
}

export function loadDesiredServices(db: Database.Database): DesiredService[] {
  const rows = db.prepare(`
    SELECT
      s.id AS serviceId,
      c.full_name AS clientName,
      s.status AS status,
      s.pppoe_username AS username,
      s.pppoe_password AS password,
      p.download_mbps AS downloadMbps,
      p.upload_mbps AS uploadMbps
    FROM services s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    WHERE s.pppoe_username IS NOT NULL AND TRIM(s.pppoe_username) <> ''
    ORDER BY s.id
  `).all() as ServiceRow[];

  return rows.map((row) => ({
    serviceId: row.serviceId,
    clientName: row.clientName,
    username: row.username,
    password: row.password,
    enabled: row.status === 'active',
    rateLimit: rateLimitFor(row.uploadMbps, row.downloadMbps)
  }));
}

// --------------------------------------------------------------- planeamento

function matchSecret(service: DesiredService, secrets: RouterSecret[]): RouterSecret | undefined {
  const tag = `${COMMENT_PREFIX}${service.serviceId}`;
  return (
    secrets.find((secret) => secret.comment === tag) ??
    secrets.find((secret) => secret.name === service.username)
  );
}

/**
 * Função pura: dado o desejado e o que está no router, o que há a fazer.
 * É aqui que vive a decisão toda — o resto do módulo é entrada/saída.
 */
export function planActions(desired: DesiredService[], secrets: RouterSecret[]): EnforcementPlan {
  const actions: PlannedAction[] = [];
  const divergences: Divergence[] = [];
  const matched = new Map<number, RouterSecret>();
  const usedSecretIds = new Set<string>();

  for (const service of desired) {
    const secret = matchSecret(service, secrets);

    if (!secret) {
      divergences.push({
        serviceId: service.serviceId,
        username: service.username,
        kind: 'missing_secret',
        detail: 'Sem utilizador PPPoE no router'
      });
      actions.push({
        kind: 'create',
        serviceId: service.serviceId,
        username: service.username,
        rateLimit: service.rateLimit,
        clientName: service.clientName
      });
      continue;
    }

    matched.set(service.serviceId, secret);
    usedSecretIds.add(secret.id);

    const routerEnabled = !secret.disabled;
    if (routerEnabled !== service.enabled) {
      divergences.push({
        serviceId: service.serviceId,
        username: service.username,
        kind: 'state',
        detail: service.enabled ? 'Desativado no router mas o serviço está ativo' : 'Ativo no router mas o serviço não está'
      });
      actions.push({
        kind: service.enabled ? 'enable' : 'disable',
        serviceId: service.serviceId,
        username: service.username,
        secretId: secret.id,
        clientName: service.clientName
      });
    }

    // Velocidade: só se age quando o plano tem números. Um plano sem Mbps
    // definidos deixa em paz o que estiver configurado à mão no router.
    if (service.rateLimit && secret.rateLimit !== service.rateLimit) {
      divergences.push({
        serviceId: service.serviceId,
        username: service.username,
        kind: 'rate_limit',
        detail: `Router em ${secret.rateLimit ?? 'sem limite'}, plano pede ${service.rateLimit}`
      });
      actions.push({
        kind: 'rate_limit',
        serviceId: service.serviceId,
        username: service.username,
        secretId: secret.id,
        rateLimit: service.rateLimit,
        clientName: service.clientName
      });
    }
  }

  // Secrets marcados como nossos que já não correspondem a nenhum serviço.
  // Reportados e nunca apagados: apagar o que não criámos nesta passagem é como
  // se perde configuração de propósito.
  for (const secret of secrets) {
    if (usedSecretIds.has(secret.id)) continue;
    if (!secret.comment?.startsWith(COMMENT_PREFIX)) continue;
    divergences.push({
      serviceId: Number(secret.comment.slice(COMMENT_PREFIX.length)) || null,
      username: secret.name,
      kind: 'orphan_secret',
      detail: 'Utilizador no router sem serviço correspondente no ISPM'
    });
  }

  return { actions, divergences, matched };
}

// ------------------------------------------------------------------ escrita

export type EnforcementDeps = {
  transport: RouterTransport;
  dryRun: boolean;
  maxDisables: number;
};

export type EnforcementSummary = {
  skipped?: true;
  reason?: string;
  dryRun: boolean;
  services: number;
  online: number;
  planned: number;
  applied: number;
  failed: number;
  divergences: number;
  aborted?: true;
  actions: PlannedAction[];
};

const upsertState = `
  INSERT INTO service_network_state (
    service_id, secret_id, router_enabled, desired_enabled, rate_limit,
    online, address, uptime, last_online_at, divergence, last_error, checked_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(service_id) DO UPDATE SET
    secret_id = excluded.secret_id,
    router_enabled = excluded.router_enabled,
    desired_enabled = excluded.desired_enabled,
    rate_limit = excluded.rate_limit,
    online = excluded.online,
    address = excluded.address,
    uptime = excluded.uptime,
    last_online_at = COALESCE(excluded.last_online_at, service_network_state.last_online_at),
    divergence = excluded.divergence,
    last_error = excluded.last_error,
    checked_at = datetime('now')
`;

function recordSystemAudit(db: Database.Database, action: string, serviceId: number, summary: string): void {
  try {
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary)
      VALUES (NULL, 'sistema', NULL, ?, 'service', ?, ?)
    `).run(action, String(serviceId), summary);
  } catch {
    // A auditoria não pode fazer falhar a operação que já aconteceu na rede.
  }
}

function recordNetworkEvent(db: Database.Database, serviceId: number, type: 'corte_rede' | 'reposicao_rede', note: string): void {
  try {
    db.prepare(`INSERT INTO service_events (service_id, event_type, notes) VALUES (?, ?, ?)`).run(serviceId, type, note);
  } catch {
    // Idem: o corte já aconteceu, o registo não o desfaz.
  }
}

/**
 * Uma passagem completa: lê o router, planeia, aplica (se não for ensaio) e
 * guarda o estado. Um erro de rede numa ação individual não corrompe o resto —
 * fica registado no serviço e a passagem seguinte volta a tentar.
 */
export async function runNetworkEnforcement(db: Database.Database, deps: EnforcementDeps): Promise<EnforcementSummary> {
  const desired = loadDesiredServices(db);
  if (desired.length === 0) {
    return { dryRun: deps.dryRun, services: 0, online: 0, planned: 0, applied: 0, failed: 0, divergences: 0, actions: [], skipped: true, reason: 'Nenhum servico com utilizador PPPoE' };
  }

  const [secrets, active] = await Promise.all([listSecrets(deps.transport), listActive(deps.transport)]);
  const plan = planActions(desired, secrets);
  const activeByName = new Map<string, RouterActive>(active.map((session) => [session.name, session]));

  const disables = plan.actions.filter((action) => action.kind === 'disable').length;
  // Trava de segurança: uma passagem que quer cortar meia cidade é um erro de
  // dados ou de mapeamento, não um dia de cobranças. Não corta nenhum.
  const aborted = !deps.dryRun && disables > deps.maxDisables;

  const errors = new Map<number, string>();
  let applied = 0;

  if (!deps.dryRun && !aborted) {
    // Repor antes de cortar: se a passagem falhar a meio, ninguém fica sem
    // serviço à espera do tick seguinte.
    const ordered = [...plan.actions].sort((a, b) => rank(a) - rank(b));
    for (const action of ordered) {
      try {
        await applyAction(db, deps.transport, action, activeByName, desired);
        applied += 1;
      } catch (err) {
        errors.set(action.serviceId, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const divergenceByService = new Map<number, string>();
  for (const divergence of plan.divergences) {
    if (divergence.serviceId != null && !divergenceByService.has(divergence.serviceId)) {
      divergenceByService.set(divergence.serviceId, divergence.kind);
    }
  }

  const persist = db.transaction(() => {
    const statement = db.prepare(upsertState);
    for (const service of desired) {
      const secret = plan.matched.get(service.serviceId);
      const session = activeByName.get(service.username);
      statement.run(
        service.serviceId,
        secret?.id ?? null,
        secret ? (secret.disabled ? 0 : 1) : null,
        service.enabled ? 1 : 0,
        secret?.rateLimit ?? null,
        session ? 1 : 0,
        session?.address ?? null,
        session?.uptime ?? null,
        session ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
        divergenceByService.get(service.serviceId) ?? null,
        errors.get(service.serviceId) ?? null
      );
    }
  });
  persist();

  return {
    dryRun: deps.dryRun,
    services: desired.length,
    online: activeByName.size,
    planned: plan.actions.length,
    applied,
    failed: errors.size,
    divergences: plan.divergences.length,
    actions: plan.actions,
    ...(aborted ? { aborted: true as const, reason: `${disables} cortes numa passagem excedem o limite de ${deps.maxDisables}` } : {})
  };
}

function rank(action: PlannedAction): number {
  if (action.kind === 'create') return 0;
  if (action.kind === 'enable') return 1;
  if (action.kind === 'rate_limit') return 2;
  return 3; // disable
}

async function applyAction(
  db: Database.Database,
  transport: RouterTransport,
  action: PlannedAction,
  activeByName: Map<string, RouterActive>,
  desired: DesiredService[]
): Promise<void> {
  if (action.kind === 'create') {
    const service = desired.find((item) => item.serviceId === action.serviceId);
    if (!service?.password) {
      throw new Error('Servico sem senha PPPoE gravada');
    }
    const id = await createSecret(transport, {
      name: action.username,
      password: service.password,
      comment: `${COMMENT_PREFIX}${action.serviceId}`,
      rateLimit: action.rateLimit
    });
    // Um secret nasce ativo; se o serviço não está ativo, corta-se já.
    if (!service.enabled && id) {
      await patchSecret(transport, id, { disabled: true });
    }
    recordSystemAudit(db, 'network_provision', action.serviceId, `Criou utilizador PPPoE ${action.username} no router`);
    return;
  }

  if (action.kind === 'rate_limit') {
    await patchSecret(transport, action.secretId, { rateLimit: action.rateLimit });
    recordSystemAudit(db, 'network_rate_limit', action.serviceId, `Velocidade de ${action.username} passou a ${action.rateLimit}`);
    return;
  }

  const disabling = action.kind === 'disable';
  await patchSecret(transport, action.secretId, { disabled: disabling });

  if (disabling) {
    // Sem derrubar a sessão, o cortado fica online até reconectar sozinho —
    // podem ser dias.
    const session = activeByName.get(action.username);
    if (session) {
      await removeActive(transport, session.id);
      activeByName.delete(action.username);
    }
  }

  recordSystemAudit(
    db,
    disabling ? 'network_disable' : 'network_enable',
    action.serviceId,
    `${disabling ? 'Cortou' : 'Repôs'} o acesso de ${action.clientName} (${action.username})`
  );
  recordNetworkEvent(
    db,
    action.serviceId,
    disabling ? 'corte_rede' : 'reposicao_rede',
    disabling ? 'Acesso cortado no router' : 'Acesso reposto no router'
  );
}

/** Chamada pelo agendador: só corre com o router ligado e configurado. */
export async function runNetworkEnforcementIfDue(): Promise<EnforcementSummary> {
  const db = getSqliteDatabase();
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) {
    return { skipped: true, reason: 'Router desligado ou por configurar', dryRun: config.dryRun, services: 0, online: 0, planned: 0, applied: 0, failed: 0, divergences: 0, actions: [] };
  }
  return runNetworkEnforcement(db, {
    transport: createTransport(config),
    dryRun: config.dryRun,
    maxDisables: config.maxDisablesPerRun
  });
}

// ------------------------------------------------------------------ leitura

export type NetworkStateRow = {
  serviceId: number;
  clientName: string;
  username: string;
  status: string;
  routerEnabled: number | null;
  desiredEnabled: number;
  online: number;
  address: string | null;
  uptime: string | null;
  lastOnlineAt: string | null;
  divergence: string | null;
  lastError: string | null;
  checkedAt: string;
};

export function loadNetworkEnforcementState(db: Database.Database): {
  services: NetworkStateRow[];
  online: number;
  divergences: number;
} {
  const services = db.prepare(`
    SELECT
      n.service_id AS serviceId,
      c.full_name AS clientName,
      s.pppoe_username AS username,
      s.status AS status,
      n.router_enabled AS routerEnabled,
      n.desired_enabled AS desiredEnabled,
      n.online AS online,
      n.address AS address,
      n.uptime AS uptime,
      n.last_online_at AS lastOnlineAt,
      n.divergence AS divergence,
      n.last_error AS lastError,
      n.checked_at AS checkedAt
    FROM service_network_state n
    JOIN services s ON s.id = n.service_id
    JOIN clients c ON c.id = s.client_id
    ORDER BY (n.divergence IS NULL), c.full_name
  `).all() as NetworkStateRow[];

  return {
    services,
    online: services.filter((row) => row.online === 1).length,
    divergences: services.filter((row) => row.divergence).length
  };
}
