import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { escudosToCentavos, roundEscudos } from '../../shared/money';
import { changeServiceStatus } from './services';
import { isRouterConfigured, readRouterConfig } from './routeros';

const DEFAULT_GRACE_DAYS = 15;
const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_MAX_PER_RUN = 5;
const DEFAULT_MAX_PERCENT = 20;

export type AutoSuspensionConfig = {
  enabled: boolean;
  graceDays: number;
  intervalMinutes: number;
  maxPerRun: number;
  maxPercent: number;
  dryRun: boolean;
  routerReady: boolean;
};

export type SuspensionCandidate = {
  serviceId: number;
  clientId: number;
  clientName: string;
  username: string;
  paymentId: number;
  invoiceNumber: string | null;
  dueDate: string;
  daysOverdue: number;
  balanceCve: number;
  creditCve: number;
};

export type AutoSuspensionPreview = AutoSuspensionConfig & {
  controlledActiveServices: number;
  candidates: SuspensionCandidate[];
  blockedByCredit: SuspensionCandidate[];
  candidateCount: number;
  blockedByCreditCount: number;
  candidatePercent: number;
  guardTriggered: boolean;
  guardReason: string | null;
};

export type AutoSuspensionRun = AutoSuspensionPreview & {
  skipped?: true;
  aborted?: true;
  simulated: number;
  applied: number;
  revalidatedOut: number;
  reason?: string;
};

function setting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() ?? '';
}

function intSetting(
  db: Database.Database,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(setting(db, key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
}

function clientCredit(db: Database.Database, clientId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cve), 0) AS total
    FROM client_credits
    WHERE client_id = ?
  `).get(clientId) as { total: number };
  return roundEscudos(row.total);
}

const balanceExpr = `(
  p.amount_cve - COALESCE((
    SELECT SUM(r.amount_cve)
    FROM payment_receipts r
    WHERE r.payment_id = p.id AND r.voided_at IS NULL
  ), 0)
)`;

function graceDays(db: Database.Database): number {
  return intSetting(db, 'autoSuspensionGraceDays', DEFAULT_GRACE_DAYS, 1, 120);
}

export function readAutoSuspensionConfig(db: Database.Database): AutoSuspensionConfig {
  const router = readRouterConfig(db);
  return {
    enabled: setting(db, 'autoSuspensionEnabled') === 'true',
    graceDays: graceDays(db),
    intervalMinutes: intSetting(db, 'autoSuspensionIntervalMinutes', DEFAULT_INTERVAL_MINUTES, 5, 1440),
    maxPerRun: intSetting(db, 'autoSuspensionMaxPerRun', DEFAULT_MAX_PER_RUN, 1, 500),
    maxPercent: intSetting(db, 'autoSuspensionMaxPercent', DEFAULT_MAX_PERCENT, 1, 100),
    dryRun: router.dryRun,
    routerReady: router.enabled && isRouterConfigured(router)
  };
}

/** Lido a cada tick para alterações nas Definições valerem sem reiniciar. */
export function autoSuspensionIntervalMs(): number {
  return readAutoSuspensionConfig(getSqliteDatabase()).intervalMinutes * 60_000;
}

function activeControlledCount(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.status = 'active'
      AND c.status <> 'cancelled'
      AND s.pppoe_username IS NOT NULL
      AND TRIM(s.pppoe_username) <> ''
  `).get() as { n: number };
  return row.n;
}

/** A fatura elegível mais antiga por serviço. */
function rawCandidates(db: Database.Database, graceDays: number): SuspensionCandidate[] {
  const rows = db.prepare(`
    SELECT
      s.id AS serviceId,
      s.client_id AS clientId,
      c.full_name AS clientName,
      s.pppoe_username AS username,
      p.id AS paymentId,
      p.invoice_number AS invoiceNumber,
      p.due_date AS dueDate,
      CAST(julianday(date('now')) - julianday(date(p.due_date)) AS INTEGER) AS daysOverdue,
      ${balanceExpr} AS balanceCve
    FROM services s
    JOIN clients c ON c.id = s.client_id
    JOIN payments p ON p.service_id = s.id
    WHERE s.status = 'active'
      AND c.status <> 'cancelled'
      AND s.pppoe_username IS NOT NULL
      AND TRIM(s.pppoe_username) <> ''
      AND p.status IN ('pending', 'overdue')
      AND date(p.due_date, '+' || ? || ' days') < date('now')
      AND ${balanceExpr} > 0.005
    ORDER BY s.id, date(p.due_date), p.id
  `).all(graceDays) as Array<Omit<SuspensionCandidate, 'creditCve'>>;

  const oldestByService = new Map<number, SuspensionCandidate>();
  for (const row of rows) {
    if (oldestByService.has(row.serviceId)) continue;
    oldestByService.set(row.serviceId, {
      ...row,
      balanceCve: roundEscudos(row.balanceCve),
      creditCve: clientCredit(db, row.clientId)
    });
  }
  return [...oldestByService.values()];
}

function guardFor(
  candidates: number,
  controlledActiveServices: number,
  maxPerRun: number,
  maxPercent: number
): { triggered: boolean; reason: string | null; percent: number } {
  const percent = controlledActiveServices > 0
    ? Math.round((candidates / controlledActiveServices) * 10_000) / 100
    : 0;
  if (candidates > maxPerRun) {
    return {
      triggered: true,
      reason: `${candidates} suspensões excedem o limite de ${maxPerRun} por passagem`,
      percent
    };
  }
  if (controlledActiveServices > 0 && percent > maxPercent) {
    return {
      triggered: true,
      reason: `${percent}% dos serviços controlados excede o limite de ${maxPercent}%`,
      percent
    };
  }
  return { triggered: false, reason: null, percent };
}

export function loadAutoSuspensionPreview(db: Database.Database): AutoSuspensionPreview {
  const config = readAutoSuspensionConfig(db);
  const raw = rawCandidates(db, config.graceDays);

  // Um crédito ainda não abatido pode liquidar a fatura. Por segurança, o
  // corte automático espera revisão em vez de presumir onde aplicar o crédito.
  const candidates = raw.filter((row) => escudosToCentavos(row.creditCve) <= 0);
  const blockedByCredit = raw.filter((row) => escudosToCentavos(row.creditCve) > 0);
  const controlledActiveServices = activeControlledCount(db);
  const guard = guardFor(
    candidates.length,
    controlledActiveServices,
    config.maxPerRun,
    config.maxPercent
  );

  return {
    ...config,
    controlledActiveServices,
    candidates,
    blockedByCredit,
    candidateCount: candidates.length,
    blockedByCreditCount: blockedByCredit.length,
    candidatePercent: guard.percent,
    guardTriggered: guard.triggered,
    guardReason: guard.reason
  };
}

function hasSuspendableDebt(db: Database.Database, serviceId: number, graceDays: number): boolean {
  const row = db.prepare(`
    SELECT 1 AS found
    FROM payments p
    WHERE p.service_id = ?
      AND p.status IN ('pending', 'overdue')
      AND date(p.due_date, '+' || ? || ' days') < date('now')
      AND ${balanceExpr} > 0.005
    LIMIT 1
  `).get(serviceId, graceDays) as { found: number } | undefined;
  return Boolean(row);
}

function stillSafeToSuspend(db: Database.Database, serviceId: number, graceDays: number): boolean {
  const row = db.prepare(`
    SELECT s.client_id AS clientId, s.status, c.status AS clientStatus
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.id = ?
  `).get(serviceId) as { clientId: number; status: string; clientStatus: string } | undefined;

  if (!row || row.status !== 'active' || row.clientStatus === 'cancelled') return false;
  if (escudosToCentavos(clientCredit(db, row.clientId)) > 0) return false;
  return hasSuspendableDebt(db, serviceId, graceDays);
}

function systemAudit(db: Database.Database, action: string, entityId: number | null, summary: string): void {
  try {
    db.prepare(`
      INSERT INTO audit_logs (
        actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary
      )
      VALUES (NULL, 'sistema', NULL, ?, 'service', ?, ?)
    `).run(action, entityId == null ? null : String(entityId), summary);
  } catch {
    // A auditoria não pode fazer falhar a operação de domínio.
  }
}

export function runAutomaticSuspension(
  db: Database.Database = getSqliteDatabase()
): AutoSuspensionRun {
  const preview = loadAutoSuspensionPreview(db);

  if (!preview.enabled) {
    return {
      ...preview,
      skipped: true,
      simulated: 0,
      applied: 0,
      revalidatedOut: 0,
      reason: 'Suspensão automática desligada'
    };
  }

  if (preview.dryRun) {
    return {
      ...preview,
      simulated: preview.candidateCount,
      applied: 0,
      revalidatedOut: 0,
      reason: 'Ensaio: nenhuma alteração aplicada'
    };
  }

  if (!preview.routerReady) {
    return {
      ...preview,
      skipped: true,
      simulated: 0,
      applied: 0,
      revalidatedOut: 0,
      reason: 'Router desligado ou por configurar'
    };
  }

  if (preview.guardTriggered) {
    systemAudit(
      db,
      'mass_suspension_guard_triggered',
      null,
      `Suspensão automática travada: ${preview.guardReason ?? 'limite de segurança'}`
    );
    return {
      ...preview,
      aborted: true,
      simulated: 0,
      applied: 0,
      revalidatedOut: 0,
      reason: preview.guardReason ?? 'Limite de segurança atingido'
    };
  }

  let applied = 0;
  let revalidatedOut = 0;

  db.transaction(() => {
    for (const candidate of preview.candidates) {
      // Pagamento/crédito que entrou desde a pré-visualização ganha sempre.
      if (!stillSafeToSuspend(db, candidate.serviceId, preview.graceDays)) {
        revalidatedOut += 1;
        continue;
      }

      const invoiceLabel = candidate.invoiceNumber || ('fatura #' + candidate.paymentId);
      const result = changeServiceStatus(db, candidate.serviceId, 'suspended', {
        source: 'nonpayment',
        reason: `Suspensão automática por falta de pagamento: ${invoiceLabel} vencida em ${candidate.dueDate}, ${candidate.daysOverdue} dia(s) de atraso, saldo ${candidate.balanceCve} CVE`
      });

      if (result.ok && result.value.changed) {
        applied += 1;
        systemAudit(
          db,
          'auto_service_suspended',
          candidate.serviceId,
          `Suspendeu ${candidate.clientName} por falta de pagamento`
        );
      }
    }
  })();

  return {
    ...preview,
    simulated: 0,
    applied,
    revalidatedOut
  };
}

/**
 * Só uma suspensão criada pela própria cobrança pode ser desfeita por recibo.
 * Suspensão manual (e linhas antigas sem origem) exige decisão humana.
 */
export function reactivateServiceIfEligibleAfterPayment(
  db: Database.Database,
  serviceId: number,
  actorId: number | null = null
): boolean {
  const service = db.prepare(`
    SELECT status, suspension_source AS suspensionSource
    FROM services
    WHERE id = ?
  `).get(serviceId) as { status: string; suspensionSource: string | null } | undefined;

  if (!service || service.status !== 'suspended' || service.suspensionSource !== 'nonpayment') {
    return false;
  }

  if (hasSuspendableDebt(db, serviceId, graceDays(db))) return false;

  const result = changeServiceStatus(db, serviceId, 'active', {
    reason: 'Reativação automática após regularização da dívida',
    actorId
  });

  if (!result.ok || !result.value.changed) return false;
  systemAudit(db, 'payment_reactivated_service', serviceId, 'Serviço reativado após pagamento');
  return true;
}
