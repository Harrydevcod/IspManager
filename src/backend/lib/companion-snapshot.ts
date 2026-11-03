import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { loadDashboardSummary } from './dashboard-summary';
import { loadNetworkHealth } from './network-health';
import { loadOperationsStatus } from './operations-status';
import { readRouterLive, readWanInterfaces } from './router-live';
import type { OperationsSeverity } from '../../shared/operations-status';

/**
 * O resumo que o desktop envia ao telemóvel pareado para o Painel da app.
 * Só leitura e só o que cabe num ecrã de telemóvel: listas cortadas, valores
 * em CVE inteiros (a app formata `1.500$00`). A forma é contrato com a app
 * Android — mudar um campo obriga a subir `schemaVersion`.
 */
export type CompanionSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  companyName: string;
  operation: {
    severity: OperationsSeverity;
    headline: string;
    risks: Array<{ title: string; detail: string; severity: OperationsSeverity }>;
    actions: Array<{ title: string; detail: string; severity: OperationsSeverity; horizon: 'now' | 'week' | 'quarter' }>;
  };
  money: {
    paidMonthCve: number;
    paidPrevMonthCve: number;
    pendingMonthCve: number;
    pendingMonthCount: number;
    pendingPreviousCve: number;
    overduePayments: number;
    criticalOverdue: Array<{ clientName: string; amountCve: number; daysOverdue: number }>;
  };
  network: {
    tone: 'ok' | 'warn' | 'danger';
    probeEnabled: boolean;
    lastProbeAt: string | null;
    downCount: number;
    downNow: Array<{ name: string; since: string }>;
    findingsCount: number;
    /** null quando o router não foi lido (desligado, fora da rede, erro): `wanReason` diz porquê. */
    wans: Array<{ name: string; running: boolean; downBps: number | null; upBps: number | null }> | null;
    wanReason: string | null;
  };
  customers: { total: number; active: number; suspended: number; openWorkOrders: number; openTickets: number };
  sms: {
    today: SmsCounts;
    month: SmsCounts;
  };
};

type SmsCounts = { sent: number; delivered: number; failed: number; pending: number };

const LIST_LIMIT = 5;

// Cabo Verde é UTC-1 todo o ano: o "hoje" e o "este mês" do operador começam
// uma hora depois da meia-noite UTC. created_at é gravado em UTC.
const CV_DAY_START = `datetime('now', '-1 hours', 'start of day', '+1 hours')`;
const CV_MONTH_START = `datetime('now', '-1 hours', 'start of month', '+1 hours')`;

function smsCounts(db: Database.Database, since: string): SmsCounts {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='sent' AND delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending_dispatch','pending_approval','approved') THEN 1 ELSE 0 END) AS pending
    FROM sms_outbox WHERE created_at >= ${since}
  `).get() as Record<keyof SmsCounts, number | null>;
  return { sent: row.sent ?? 0, delivered: row.delivered ?? 0, failed: row.failed ?? 0, pending: row.pending ?? 0 };
}

async function readWans(db: Database.Database): Promise<Pick<CompanionSnapshot['network'], 'wans' | 'wanReason'>> {
  const live = await readRouterLive(db, readWanInterfaces);
  if (!live.available) return { wans: null, wanReason: live.reason };
  if ('missing' in live) return { wans: null, wanReason: 'O router não tem a lista de interfaces WAN.' };
  return { wans: live.interfaces, wanReason: null };
}

export async function buildCompanionSnapshot(
  db: Database.Database = getSqliteDatabase(),
  now: Date = new Date(),
  wanReader: (db: Database.Database) => Promise<Pick<CompanionSnapshot['network'], 'wans' | 'wanReason'>> = readWans
): Promise<CompanionSnapshot> {
  const ops = loadOperationsStatus(db, now);
  const summary = loadDashboardSummary(db);
  const health = loadNetworkHealth(db, 24, now);
  const company = db.prepare(`SELECT value FROM app_settings WHERE key = 'companyName'`).get() as { value: string } | undefined;

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    companyName: company?.value?.trim() || 'ISPM',
    operation: {
      severity: ops.severity,
      headline: ops.headline,
      risks: ops.risks.slice(0, LIST_LIMIT).map(({ title, detail, severity }) => ({ title, detail, severity })),
      actions: ops.actions.slice(0, LIST_LIMIT).map(({ title, detail, severity, horizon }) => ({ title, detail, severity, horizon }))
    },
    money: {
      paidMonthCve: summary.paidMonthCve,
      paidPrevMonthCve: summary.paidPrevMonthCve,
      pendingMonthCve: summary.pendingMonthCve,
      pendingMonthCount: summary.pendingMonthCount,
      pendingPreviousCve: summary.pendingPreviousCve,
      overduePayments: summary.overduePayments,
      criticalOverdue: summary.criticalOverdue.slice(0, LIST_LIMIT)
        .map(({ clientName, amountCve, daysOverdue }) => ({ clientName, amountCve: Number(amountCve) || 0, daysOverdue }))
    },
    network: {
      tone: health.tone,
      probeEnabled: health.probeEnabled,
      lastProbeAt: health.lastProbeAt,
      downCount: health.downNow.length,
      downNow: health.downNow.slice(0, LIST_LIMIT).map(({ name, since }) => ({ name, since })),
      findingsCount: health.findings.length,
      ...(await wanReader(db).catch((err: unknown) => ({ wans: null, wanReason: err instanceof Error ? err.message : 'Router indisponível' })))
    },
    customers: {
      total: summary.totalClients,
      active: summary.activeClients,
      suspended: summary.suspendedClients,
      openWorkOrders: summary.openWorkOrders,
      openTickets: summary.openTickets
    },
    sms: {
      today: smsCounts(db, CV_DAY_START),
      month: smsCounts(db, CV_MONTH_START)
    }
  };
}
