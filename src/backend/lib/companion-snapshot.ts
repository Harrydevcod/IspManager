import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { loadDashboardSummary } from './dashboard-summary';
import { loadNetworkHealth } from './network-health';
import { loadOperationsStatus } from './operations-status';
import { readRouterLive, readWanInterfaces } from './router-live';
import type { OperationsSeverity } from '../../shared/operations-status';
import { normalizeSmsPhone } from '../../shared/sms';
import { balanceSqlExpr, cashReceiptFilterSql, overdueSqlPredicate } from './payments';
import { openPaymentLinkSql } from './vinti4';

/**
 * O resumo que o desktop envia ao telemóvel pareado para o Painel da app.
 * Só leitura e só o que cabe num ecrã de telemóvel: listas cortadas, valores
 * em CVE inteiros (a app formata `1.500$00`). A forma é contrato com a app
 * Android — mudar um campo obriga a subir `schemaVersion`. Acrescentar um campo
 * NÃO obriga: a app ignora o que não conhece e trata o que falta como vazio
 * (assim a 0.4.0 continua a ler um desktop novo, e a 0.5.0 um desktop antigo).
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
    /** Cobrar no terreno: clientes com dívida vencida, maior primeiro. */
    debtors: Array<{
      clientName: string; clientCode: string; phone: string | null; amountCve: number; daysOverdue: number;
      /** O link que os avisos já usam (EasyLink válido, senão Stripe) da fatura vencida mais recente; e o valor dela. */
      paymentLink: string | null; paymentLinkAmountCve: number | null;
    }>;
    /** Recibos de hoje (hora de Cabo Verde), por caixa ou banco. */
    cashToday: { totalCve: number; byAccount: Array<{ name: string; amountCve: number }> };
    /** Recebido por mês, do mais antigo ao atual (6 meses). */
    monthlyReceipts: Array<{ month: string; amountCve: number }>;
  };
  network: {
    tone: 'ok' | 'warn' | 'danger';
    probeEnabled: boolean;
    lastProbeAt: string | null;
    downCount: number;
    /** Completa (sem corte): a app compara snapshots para avisar quedas e recuperações. */
    downNow: Array<{ kind: 'backbone' | 'assignment'; id: number; name: string; since: string }>;
    findingsCount: number;
    /** null quando o router não foi lido (desligado, fora da rede, erro): `wanReason` diz porquê. */
    wans: Array<{ name: string; running: boolean; downBps: number | null; upBps: number | null }> | null;
    wanReason: string | null;
  };
  customers: { total: number; active: number; suspended: number; openWorkOrders: number; openTickets: number };
  work: {
    orders: Array<{
      id: number; title: string; priority: string; scheduledAt: string | null; assignedTo: string | null;
      clientName: string | null; phone: string | null; address: string | null; zone: string | null; island: string | null;
    }>;
    tickets: Array<{ id: number; subject: string; priority: string; openedAt: string; clientName: string; phone: string | null }>;
  };
  sms: {
    today: SmsCounts;
    month: SmsCounts;
  };
  /** Clientes no bolso: todos menos os cancelados, cortados por bytes (CLIENTS_BUDGET_BYTES). */
  clients: CompanionClient[];
};

export type CompanionClient = {
  code: string; name: string; phone: string | null; status: string;
  plan: string | null; zone: string | null; island: string | null;
  /** Dívida vencida, na mesma regra do Cobrar. */
  overdueCve: number;
  lastPaymentAt: string | null;
};

// O telemóvel aceita 300 KB por pedido e, selado, o JSON cresce ~4/3 em base64:
// 150 KB são ~1000 clientes e deixam folga ao resto do resumo (~10 KB).
export const CLIENTS_BUDGET_BYTES = 150 * 1024;

type SmsCounts = { sent: number; delivered: number; failed: number; pending: number };

const LIST_LIMIT = 5;
// Listas de trabalho: o que se percorre no terreno num dia, não o arquivo.
const FIELD_LIMIT = 15;
const PRIORITY_ORDER = (col: string) => `CASE ${col} WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END`;

/** Número pronto a marcar (+238…), ou null quando o registo não tem um válido. */
function dialable(phone: string | null): string | null {
  return phone ? normalizeSmsPhone(phone) || null : null;
}

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

function loadDebtors(db: Database.Database): CompanionSnapshot['money']['debtors'] {
  const rows = db.prepare(`
    SELECT c.full_name AS clientName, c.client_code AS clientCode, c.phone,
           SUM(${balanceSqlExpr('p')}) AS amountCve,
           MAX(CAST(julianday('now') - julianday(p.due_date) AS INTEGER)) AS daysOverdue,
           (SELECT ${openPaymentLinkSql('l')} FROM payments l
             WHERE l.client_id = c.id AND ${overdueSqlPredicate('l')} AND ${openPaymentLinkSql('l')} IS NOT NULL
             ORDER BY l.due_date DESC, l.id DESC LIMIT 1) AS paymentLink,
           (SELECT ${balanceSqlExpr('l')} FROM payments l
             WHERE l.client_id = c.id AND ${overdueSqlPredicate('l')} AND ${openPaymentLinkSql('l')} IS NOT NULL
             ORDER BY l.due_date DESC, l.id DESC LIMIT 1) AS paymentLinkAmountCve
    FROM payments p JOIN clients c ON c.id = p.client_id
    WHERE ${overdueSqlPredicate('p')}
    GROUP BY c.id
    HAVING amountCve > 0
    ORDER BY amountCve DESC
    LIMIT ${FIELD_LIMIT}
  `).all() as CompanionSnapshot['money']['debtors'];
  return rows.map((r) => ({
    ...r,
    phone: dialable(r.phone),
    amountCve: Number(r.amountCve) || 0,
    paymentLink: r.paymentLink ?? null,
    paymentLinkAmountCve: r.paymentLink && r.paymentLinkAmountCve != null ? Number(r.paymentLinkAmountCve) : null
  }));
}

const ptCollator = new Intl.Collator('pt', { sensitivity: 'base' });

/** Cada cliente que não está cancelado, por nome; corta quando o JSON passa o orçamento. */
export function loadClients(db: Database.Database, budgetBytes = CLIENTS_BUDGET_BYTES): CompanionClient[] {
  const rows = db.prepare(`
    SELECT c.client_code AS code, c.full_name AS name, c.phone, c.status, c.zone, c.island,
           (SELECT GROUP_CONCAT(name, ' + ') FROM (
              SELECT DISTINCT ip.name FROM services s JOIN internet_plans ip ON ip.id = s.plan_id
              WHERE s.client_id = c.id AND s.status != 'cancelled' ORDER BY ip.name)) AS plan,
           COALESCE((SELECT SUM(${balanceSqlExpr('p')}) FROM payments p
             WHERE p.client_id = c.id AND ${overdueSqlPredicate('p')}), 0) AS overdueCve,
           (SELECT MAX(r.payment_date) FROM payment_receipts r JOIN payments p ON p.id = r.payment_id
             WHERE p.client_id = c.id AND ${cashReceiptFilterSql('r')}) AS lastPaymentAt
    FROM clients c
    WHERE c.status != 'cancelled'
  `).all() as CompanionClient[];
  // O SQLite só ordena ASCII sem maiúsculas: "Álvaro" ia parar depois do "Z".
  rows.sort((a, b) => ptCollator.compare(a.name, b.name));
  const out: CompanionClient[] = [];
  let bytes = 2;
  for (const row of rows) {
    const client = { ...row, phone: dialable(row.phone), overdueCve: Math.max(0, Number(row.overdueCve) || 0) };
    bytes += Buffer.byteLength(JSON.stringify(client)) + 1;
    // ponytail: corte simples pelo fim do alfabeto; ordenar por relevância se algum ISP passar o orçamento.
    if (bytes > budgetBytes) break;
    out.push(client);
  }
  return out;
}

function loadCashToday(db: Database.Database): CompanionSnapshot['money']['cashToday'] {
  const byAccount = db.prepare(`
    SELECT COALESCE(a.name, 'Sem conta') AS name, SUM(r.amount_cve) AS amountCve
    FROM payment_receipts r LEFT JOIN treasury_accounts a ON a.id = r.account_id
    WHERE ${cashReceiptFilterSql('r')} AND r.payment_date = date('now', '-1 hours')
    GROUP BY r.account_id
    ORDER BY amountCve DESC
  `).all() as Array<{ name: string; amountCve: number }>;
  return {
    totalCve: byAccount.reduce((sum, row) => sum + (Number(row.amountCve) || 0), 0),
    byAccount: byAccount.map((row) => ({ name: row.name, amountCve: Number(row.amountCve) || 0 }))
  };
}

function loadMonthlyReceipts(db: Database.Database): CompanionSnapshot['money']['monthlyReceipts'] {
  const months = [5, 4, 3, 2, 1, 0].map((back) =>
    (db.prepare(`SELECT strftime('%Y-%m', date('now', '-1 hours', 'start of month', ?)) AS m`).get(`-${back} months`) as { m: string }).m);
  const totals = new Map((db.prepare(`
    SELECT substr(r.payment_date, 1, 7) AS month, SUM(r.amount_cve) AS amountCve
    FROM payment_receipts r
    WHERE ${cashReceiptFilterSql('r')} AND substr(r.payment_date, 1, 7) >= ?
    GROUP BY month
  `).all(months[0]) as Array<{ month: string; amountCve: number }>).map((row) => [row.month, Number(row.amountCve) || 0]));
  // Meses sem recibos aparecem a zero: o gráfico tem sempre seis barras.
  return months.map((month) => ({ month, amountCve: totals.get(month) ?? 0 }));
}

function loadWork(db: Database.Database): CompanionSnapshot['work'] {
  const orders = db.prepare(`
    SELECT w.id, w.title, w.priority, w.scheduled_at AS scheduledAt, w.assigned_to AS assignedTo,
           c.full_name AS clientName, c.phone, c.address, c.zone, c.island
    FROM work_orders w
    LEFT JOIN services s ON s.id = w.service_id
    LEFT JOIN clients c ON c.id = s.client_id
    WHERE w.status NOT IN ('concluida', 'cancelada')
    ORDER BY ${PRIORITY_ORDER('w.priority')}, w.scheduled_at IS NULL, w.scheduled_at, w.id
    LIMIT ${FIELD_LIMIT}
  `).all() as CompanionSnapshot['work']['orders'];
  const tickets = db.prepare(`
    SELECT t.id, t.subject, t.priority, t.opened_at AS openedAt, c.full_name AS clientName, c.phone
    FROM support_tickets t JOIN clients c ON c.id = t.client_id
    WHERE t.status IN ('aberto', 'em_curso')
    ORDER BY ${PRIORITY_ORDER('t.priority')}, t.opened_at
    LIMIT ${FIELD_LIMIT}
  `).all() as CompanionSnapshot['work']['tickets'];
  return {
    orders: orders.map((o) => ({ ...o, phone: dialable(o.phone) })),
    tickets: tickets.map((t) => ({ ...t, phone: dialable(t.phone) }))
  };
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
        .map(({ clientName, amountCve, daysOverdue }) => ({ clientName, amountCve: Number(amountCve) || 0, daysOverdue })),
      debtors: loadDebtors(db),
      cashToday: loadCashToday(db),
      monthlyReceipts: loadMonthlyReceipts(db)
    },
    network: {
      tone: health.tone,
      probeEnabled: health.probeEnabled,
      lastProbeAt: health.lastProbeAt,
      downCount: health.downNow.length,
      downNow: health.downNow.map(({ kind, id, name, since }) => ({ kind, id, name, since })),
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
    work: loadWork(db),
    sms: {
      today: smsCounts(db, CV_DAY_START),
      month: smsCounts(db, CV_MONTH_START)
    },
    clients: loadClients(db)
  };
}
