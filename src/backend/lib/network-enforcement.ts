import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { readBaseProfileName, readSuspendedProfileName, syncPlanProfiles, type PlanSyncSummary } from './plan-profiles';
import {
  createSecret,
  createTransport,
  isRouterConfigured,
  listActive,
  listProfiles,
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
  /** Password local alterada e ainda não confirmada no router. */
  passwordPending: boolean;
  /** Verdadeiro para ativos e suspensos por perfil. */
  enabled: boolean;
  suspended?: boolean;
  /**
   * Perfil PPP do plano (`internet_plans.router_profile`). É no perfil que o
   * RouterOS guarda a velocidade; o perfil é do operador, o ISPM só aponta o
   * secret para ele. Null = o plano não diz, e o que estiver no secret fica.
   */
  profile: string | null;
};

export type PlannedAction =
  | { kind: 'create'; serviceId: number; username: string; profile: string | null; clientName: string }
  | { kind: 'enable' | 'disable'; serviceId: number; username: string; secretId: string; clientName: string; cut?: true }
  | { kind: 'profile'; serviceId: number; username: string; secretId: string; profile: string; from: string | null; clientName: string; cut?: true }
  /** `rename`: o secret no router tem outro nome e as credenciais do ISPM mandam (reinstalação). */
  | { kind: 'password'; serviceId: number; username: string; secretId: string; clientName: string; rename?: true };

export type Divergence = {
  serviceId: number | null;
  username: string;
  kind: 'missing_secret' | 'state' | 'profile' | 'password' | 'username' | 'orphan_secret';
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
  passwordPending: number;
  profile: string | null;
};

export function loadDesiredServices(db: Database.Database, options: { suspendedProfile: string } = { suspendedProfile: readSuspendedProfileName(db) }): DesiredService[] {
  const rows = db.prepare(`
    SELECT
      s.id AS serviceId,
      c.full_name AS clientName,
      s.status AS status,
      s.pppoe_username AS username,
      s.pppoe_password AS password,
      s.pppoe_password_sync_pending AS passwordPending,
      NULLIF(TRIM(p.router_profile), '') AS profile
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
    passwordPending: row.passwordPending === 1,
    enabled: row.status === 'active' || (row.status === 'suspended' && Boolean(options.suspendedProfile)),
    profile: row.status === 'suspended' && options.suspendedProfile ? options.suspendedProfile : row.profile,
    ...(row.status === 'suspended' && options.suspendedProfile ? { suspended: true } : {})
  }));
}

// --------------------------------------------------------------- planeamento

export function matchSecret(service: Pick<DesiredService, 'serviceId' | 'username'>, secrets: RouterSecret[]): RouterSecret | undefined {
  const tag = `${COMMENT_PREFIX}${service.serviceId}`;
  return (
    secrets.find((secret) => secret.comment === tag) ??
    secrets.find((secret) => secret.name === service.username)
  );
}

export type SessionState = 'online' | 'offline' | 'desativado' | 'sem_secret' | 'sem_servico';

export type SessionRow = {
  serviceId: number | null;
  clientName: string | null;
  /** O nome do secret no router — é o que a sessão usa. */
  login: string;
  state: SessionState;
  online: boolean;
  suspended: boolean;
  address: string | null;
  uptime: string | null;
  routerProfile: string | null;
};

/**
 * Função pura: cada serviço PPPoE do ISPM ao lado do seu secret e da sessão, e
 * no fim os secrets do router que nenhum serviço reclama. O casamento é o da
 * reconciliação (`matchSecret`), para as duas vistas nunca discordarem.
 */
export function buildSessionRows(desired: DesiredService[], secrets: RouterSecret[], active: RouterActive[]): SessionRow[] {
  const sessions = new Map(active.map((session) => [session.name, session]));
  const claimed = new Set<string>();

  const rows: SessionRow[] = desired.map((service) => {
    const secret = matchSecret(service, secrets);
    if (secret) claimed.add(secret.id);
    const login = secret?.name ?? service.username;
    const session = secret ? sessions.get(login) : undefined;
    return {
      serviceId: service.serviceId,
      clientName: service.clientName,
      login,
      state: !secret ? 'sem_secret' : secret.disabled ? 'desativado' : session ? 'online' : 'offline',
      online: Boolean(session),
      suspended: Boolean(service.suspended),
      address: session?.address ?? null,
      uptime: session?.uptime ?? null,
      routerProfile: secret?.profile ?? null
    };
  });

  for (const secret of secrets) {
    if (claimed.has(secret.id)) continue;
    const session = sessions.get(secret.name);
    rows.push({
      serviceId: null,
      clientName: null,
      login: secret.name,
      state: 'sem_servico',
      online: Boolean(session),
      suspended: false,
      address: session?.address ?? null,
      uptime: session?.uptime ?? null,
      routerProfile: secret.profile
    });
  }
  return rows;
}

/**
 * Função pura: dado o desejado e o que está no router, o que há a fazer.
 * É aqui que vive a decisão toda — o resto do módulo é entrada/saída.
 */
export function planActions(
  desired: DesiredService[],
  secrets: RouterSecret[],
  options: { reportOrphans?: boolean; suspendedProfile?: string; baseProfile?: string } = {}
): EnforcementPlan {
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
        profile: service.profile,
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
        clientName: service.clientName,
        ...(!service.enabled ? { cut: true as const } : {})
      });
    }

    // Velocidade = perfil. Um plano sem perfil preserva o ajuste manual,
    // exceto quando é preciso sair do perfil de suspensão.
    const targetProfile = service.profile ?? (
      service.enabled && options.suspendedProfile && secret.profile === options.suspendedProfile
        ? options.baseProfile ?? 'default'
        : null
    );
    if (targetProfile && secret.profile !== targetProfile) {
      divergences.push({
        serviceId: service.serviceId,
        username: service.username,
        kind: 'profile',
        detail: `Router no perfil ${secret.profile ?? 'por omissão'}, plano pede ${targetProfile}`
      });
      actions.push({
        kind: 'profile',
        serviceId: service.serviceId,
        username: service.username,
        secretId: secret.id,
        profile: targetProfile,
        from: secret.profile,
        clientName: service.clientName,
        ...(service.suspended && options.suspendedProfile === targetProfile && routerEnabled ? { cut: true as const } : {})
      });
    }

    // A password não é comparada com o router: o utilizador REST pode não ter
    // política sensitive. Uma alteração local deixa uma marca explícita que só
    // é limpa depois de um PATCH bem sucedido. Com a marca, as credenciais do
    // ISPM mandam: um nome diferente no router é renomeado na mesma ação.
    const renamed = secret.name !== service.username;
    if (service.passwordPending && service.password) {
      divergences.push({
        serviceId: service.serviceId,
        username: service.username,
        kind: 'password',
        detail: 'Password PPPoE pendente de sincronização'
      });
      actions.push({
        kind: 'password',
        serviceId: service.serviceId,
        username: service.username,
        secretId: secret.id,
        clientName: service.clientName,
        ...(renamed ? { rename: true as const } : {})
      });
    }

    // Nome diferente no router sem credenciais pendentes (renomeado no Winbox):
    // só se reporta. Renomear sozinho partia o login do equipamento do cliente.
    if (renamed) {
      divergences.push({
        serviceId: service.serviceId,
        username: service.username,
        kind: 'username',
        detail: `No router chama-se ${secret.name}`
      });
    }
  }

  // Secrets marcados como nossos que já não correspondem a nenhum serviço.
  // Reportados e nunca apagados: apagar o que não criámos nesta passagem é como
  // se perde configuração de propósito.
  if (options.reportOrphans !== false) for (const secret of secrets) {
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
  /** Quando definido, reconcilia só estes serviços. */
  serviceIds?: number[];
  /** Em reconciliação de um serviço isolado, os restantes secrets não são órfãos. */
  reportOrphans?: boolean;
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
  /** Passagem dos perfis dos planos, feita antes da dos secrets. */
  planProfiles?: PlanSyncSummary | { error: string };
};

const upsertState = `
  INSERT INTO service_network_state (
    service_id, secret_id, router_enabled, desired_enabled, profile,
    online, address, uptime, last_online_at, divergence, last_error, checked_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(service_id) DO UPDATE SET
    secret_id = excluded.secret_id,
    router_enabled = excluded.router_enabled,
    desired_enabled = excluded.desired_enabled,
    profile = excluded.profile,
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
  const suspendedProfile = readSuspendedProfileName(db);
  const baseProfile = readBaseProfileName(db);
  const allDesired = loadDesiredServices(db, { suspendedProfile });
  const wanted = deps.serviceIds ? new Set(deps.serviceIds) : null;
  const selected = wanted ? allDesired.filter((service) => wanted.has(service.serviceId)) : allDesired;
  if (selected.length === 0) {
    return { dryRun: deps.dryRun, services: 0, online: 0, planned: 0, applied: 0, failed: 0, divergences: 0, actions: [], skipped: true, reason: 'Nenhum servico com utilizador PPPoE' };
  }

  const [secrets, active] = await Promise.all([listSecrets(deps.transport), listActive(deps.transport)]);
  // Os perfis que existem no router. Sem esta leitura não se sabe se um secret
  // vai apontar para um perfil que falta; `null` = não foi possível ler.
  let routerProfiles: Set<string> | null = null;
  let profilesReadError: string | null = null;
  try {
    routerProfiles = new Set((await listProfiles(deps.transport)).map((profile) => profile.name));
  } catch (err) {
    profilesReadError = err instanceof Error ? err.message : String(err);
  }

  let suspendedProfileError: string | null = null;
  if (suspendedProfile && selected.some((service) => service.suspended)) {
    if (!routerProfiles) {
      suspendedProfileError = `Não foi possível confirmar o perfil PPP de suspensão ${suspendedProfile}: ${profilesReadError}; corte de segurança necessário`;
    } else if (!routerProfiles.has(suspendedProfile)) {
      suspendedProfileError = `Perfil PPP de suspensão ${suspendedProfile} não existe no router; corte de segurança necessário`;
    }
  }
  // Sem perfil de suspensão confirmado, um suspenso volta ao corte por disable.
  // A decisão acontece antes do planeamento para respeitar a mesma trava.
  const desired = suspendedProfileError
    ? selected.map((service) => service.suspended ? { ...service, enabled: false, profile: null, suspended: false } : service)
    : selected;
  const plan = planActions(desired, secrets, { reportOrphans: deps.reportOrphans, suspendedProfile, baseProfile });
  const activeByName = new Map<string, RouterActive>(active.map((session) => [session.name, session]));
  // A sessão PPPoE tem o nome com que o equipamento se autentica: o do secret
  // no router, que pode já não ser o da BD.
  const loginOf = (service: { serviceId: number; username: string }) =>
    plan.matched.get(service.serviceId)?.name ?? service.username;

  const cutServiceIds = new Set(plan.actions.filter((action) => 'cut' in action && action.cut).map((action) => action.serviceId));
  const disables = cutServiceIds.size;
  // Trava de segurança: uma passagem que quer cortar meia cidade é um erro de
  // dados ou de mapeamento, não um dia de cobranças. Não executa qualquer
  // ação dos serviços afetados; os restantes continuam a ser reconciliados.
  const aborted = !deps.dryRun && disables > deps.maxDisables;

  const errors = new Map<number, string>();
  let applied = 0;

  // Perfil do plano que ainda não existe no router (a passagem dos perfis
  // falhou, ou o plano não tem Mbps): quem deve ter acesso fica pendente — nem
  // criado nem ativado — até o perfil existir. Quem deve ficar sem acesso
  // continua a ser cortado.
  if (!routerProfiles) {
    for (const service of desired) {
      if (service.enabled) errors.set(service.serviceId, `Não foi possível confirmar os perfis PPP: ${profilesReadError}`);
    }
  } else {
    for (const service of desired) {
      if (service.enabled && service.profile && !routerProfiles.has(service.profile)) {
        errors.set(service.serviceId, `Perfil PPP ${service.profile} ainda não existe no router`);
      }
    }
  }

  if (!deps.dryRun) {
    // Repor antes de cortar: se a passagem falhar a meio, ninguém fica sem
    // serviço à espera do tick seguinte.
    const ordered = plan.actions
      .filter((action) => !(aborted && cutServiceIds.has(action.serviceId)))
      .sort((a, b) => rank(a) - rank(b));
    for (const action of ordered) {
      if (errors.has(action.serviceId)) continue;
      try {
        await applyAction(db, deps.transport, action, activeByName, desired, loginOf(action), suspendedProfile);
        applied += 1;
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err);
        // O perfil podia existir na leitura e desaparecer antes do PATCH. Um
        // suspenso ainda ativo não pode conservar a velocidade do plano.
        const secret = plan.matched.get(action.serviceId);
        if (action.kind === 'profile' && action.profile === suspendedProfile
          && desired.some((service) => service.serviceId === action.serviceId && service.suspended)
          && secret && !secret.disabled) {
          try {
            await applyAction(db, deps.transport, {
              kind: 'disable',
              serviceId: action.serviceId,
              username: action.username,
              secretId: action.secretId,
              clientName: action.clientName,
              cut: true
            }, activeByName, desired, loginOf(action), suspendedProfile);
            applied += 1;
          } catch (fallbackError) {
            message += `; falhou também o corte de segurança: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
          }
        }
        errors.set(action.serviceId, message);
      }
    }
  }
  if (suspendedProfileError) {
    for (const service of selected) {
      if (service.suspended && !errors.has(service.serviceId)) errors.set(service.serviceId, suspendedProfileError);
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
      const session = activeByName.get(loginOf(service));
      statement.run(
        service.serviceId,
        secret?.id ?? null,
        secret ? (secret.disabled ? 0 : 1) : null,
        service.enabled ? 1 : 0,
        secret?.profile ?? null,
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
    online: desired.filter((service) => activeByName.has(loginOf(service))).length,
    planned: plan.actions.length,
    applied,
    failed: errors.size,
    divergences: plan.divergences.length,
    actions: plan.actions,
    ...(aborted ? { aborted: true as const, reason: `${disables} cortes numa passagem excedem o limite de ${deps.maxDisables}` } : {})
  };
}

/** Só limpa a marca se a password na BD ainda é a que foi enviada ao router. */
function clearPasswordPending(db: Database.Database, serviceId: number, sent: string): void {
  db.prepare('UPDATE services SET pppoe_password_sync_pending = 0 WHERE id = ? AND pppoe_password = ?').run(serviceId, sent);
}

function rank(action: PlannedAction): number {
  if (action.kind === 'create') return 0;
  if (action.kind === 'password') return 1;
  if (action.kind === 'profile') return 2;
  if (action.kind === 'enable') return 3;
  return 4; // disable
}

async function applyAction(
  db: Database.Database,
  transport: RouterTransport,
  action: PlannedAction,
  activeByName: Map<string, RouterActive>,
  desired: DesiredService[],
  login: string,
  suspendedProfile: string
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
      profile: action.profile
    });
    // Um secret nasce ativo; se o serviço não está ativo, corta-se já.
    if (!service.enabled && id) {
      await patchSecret(transport, id, { disabled: true });
    }
    clearPasswordPending(db, action.serviceId, service.password);
    recordSystemAudit(db, 'network_provision', action.serviceId, `Criou utilizador PPPoE ${action.username} no router`);
    return;
  }

  if (action.kind === 'password') {
    const service = desired.find((item) => item.serviceId === action.serviceId);
    if (!service?.password) throw new Error('Servico sem senha PPPoE gravada');
    await patchSecret(transport, action.secretId, {
      ...(action.rename ? { name: action.username } : {}),
      password: service.password
    });
    clearPasswordPending(db, action.serviceId, service.password);
    if (action.rename) {
      // A sessão viva é do titular anterior, com as credenciais antigas.
      const session = activeByName.get(login);
      if (session) {
        await removeActive(transport, session.id);
        activeByName.delete(login);
      }
    }
    recordSystemAudit(
      db,
      'network_password',
      action.serviceId,
      action.rename
        ? `Renomeou ${login} para ${action.username} e atualizou a password PPPoE`
        : `Atualizou a password PPPoE de ${action.username}`
    );
    return;
  }

  if (action.kind === 'profile') {
    // O RouterOS aplica o perfil no login. Mudanças entre planos normais aguardam
    // a próxima ligação; entrar ou sair da suspensão exige reconexão imediata.
    await patchSecret(transport, action.secretId, { profile: action.profile });
    const enteringSuspension = Boolean(suspendedProfile && action.profile === suspendedProfile && action.from !== suspendedProfile);
    const leavingSuspension = Boolean(suspendedProfile && action.from === suspendedProfile && action.profile !== suspendedProfile);
    if (enteringSuspension || leavingSuspension) {
      const session = activeByName.get(login);
      if (session) {
        await removeActive(transport, session.id);
        activeByName.delete(login);
      }
      recordNetworkEvent(db, action.serviceId, enteringSuspension ? 'corte_rede' : 'reposicao_rede',
        enteringSuspension ? `Perfil de suspensão ${suspendedProfile} aplicado` : `Perfil de suspensão ${suspendedProfile} removido`);
    }
    recordSystemAudit(db, 'network_profile', action.serviceId,
      enteringSuspension ? `Suspendeu ${action.clientName} (${action.username}) no perfil ${suspendedProfile}`
        : leavingSuspension ? `Repôs ${action.clientName} (${action.username}) no perfil ${action.profile}`
          : `Perfil de ${action.username} passou a ${action.profile}`);
    return;
  }

  const disabling = action.kind === 'disable';
  await patchSecret(transport, action.secretId, { disabled: disabling });

  if (disabling) {
    // Sem derrubar a sessão, o cortado fica online até reconectar sozinho —
    // podem ser dias.
    const session = activeByName.get(login);
    if (session) {
      await removeActive(transport, session.id);
      activeByName.delete(login);
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
  const transport = createTransport(config);
  // Perfis antes dos secrets: um secret nunca aponta para um perfil que ainda
  // não existe. Uma falha aqui não trava cortes nem reposições — os serviços do
  // plano em falta ficam pendentes na passagem dos secrets.
  let planProfiles: PlanSyncSummary | { error: string };
  try {
    planProfiles = await syncPlanProfiles(db, { transport, dryRun: config.dryRun });
  } catch (err) {
    planProfiles = { error: err instanceof Error ? err.message : String(err) };
  }
  const summary = await runNetworkEnforcement(db, {
    transport,
    dryRun: config.dryRun,
    maxDisables: config.maxDisablesPerRun
  });
  return { ...summary, planProfiles };
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
