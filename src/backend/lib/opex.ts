import { getSqliteDatabase } from '../db/database';

/**
 * Pro-rata OPEX context, with direct allocation support.
 *
 * Expense rows can optionally pin themselves to one specific target via
 * `investment_id`, `zone`, or `client_id`. When set, the amount is attributed
 * 100% to that target and excluded from the company-wide pool. Whatever
 * remains (no target) is spread across active investments by installed
 * clients:
 *
 *   unallocatedAvg/m = SUM(unallocated.amount) / months_with_unallocated_data
 *   opexPerClient/m  = unallocatedAvg / SUM(installed_clients of active investments)
 *
 * Both the investments route and the client profitability endpoint use this
 * single source so the math stays consistent across the app.
 */
export type CompanyOpexContext = {
  totalExpensesCve: number;
  totalAllocatedCve: number;
  totalUnallocatedCve: number;
  monthsWithExpenses: number;
  monthsWithUnallocated: number;
  avgMonthlyOpex: number;
  avgMonthlyUnallocated: number;
  totalInstalledActive: number;
  /** Base instalada dos investimentos ativos SEM client_id/zone — denominador do global-share de receita. */
  totalInstalledUnlinkedActive: number;
  opexPerClientPerMonth: number;
  directByInvestment: Record<number, number>;
  directByZone: Record<string, number>;
  directByClient: Record<number, number>;
  /** Totais acumulados (não médias mensais) das despesas alocadas — para o lucro acumulado. */
  directTotalsByInvestment: Record<number, number>;
  directTotalsByZone: Record<string, number>;
  directTotalsByClient: Record<number, number>;
  /** Nº de investimentos que partilham cada zona/cliente — divisor do OPEX direto partilhado. */
  sharersByZone: Record<string, number>;
  sharersByClient: Record<number, number>;
};

export const ACTIVE_INVESTMENT_STATUSES = new Set(['ativo', 'em_execucao', 'recuperado']);

type DirectRow = {
  investmentId: number | null;
  zone: string | null;
  clientId: number | null;
  totalCve: number;
  months: number;
};

export function loadCompanyOpexContext(): CompanyOpexContext {
  const db = getSqliteDatabase();

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(amount_cve), 0) AS totalExpensesCve,
      COUNT(DISTINCT reference_month) AS monthsWithExpenses
    FROM expenses
  `).get() as { totalExpensesCve: number; monthsWithExpenses: number };

  const unallocated = db.prepare(`
    SELECT
      COALESCE(SUM(amount_cve), 0) AS totalUnallocatedCve,
      COUNT(DISTINCT reference_month) AS monthsWithUnallocated
    FROM expenses
    WHERE investment_id IS NULL AND zone IS NULL AND client_id IS NULL
  `).get() as { totalUnallocatedCve: number; monthsWithUnallocated: number };

  const directRows = db.prepare(`
    SELECT
      investment_id AS investmentId,
      zone,
      client_id AS clientId,
      COALESCE(SUM(amount_cve), 0) AS totalCve,
      COUNT(DISTINCT reference_month) AS months
    FROM expenses
    WHERE investment_id IS NOT NULL OR zone IS NOT NULL OR client_id IS NOT NULL
    GROUP BY investment_id, zone, client_id
  `).all() as DirectRow[];

  const investmentRows = db.prepare(`
    SELECT installed_clients AS installedClients, status, client_id AS clientId, zone FROM investments
  `).all() as Array<{ installedClients: number; status: string; clientId: number | null; zone: string | null }>;

  const totalExpensesCve = Number(totals.totalExpensesCve) || 0;
  const monthsWithExpenses = Math.max(1, Number(totals.monthsWithExpenses) || 0);

  const totalUnallocatedCve = Number(unallocated.totalUnallocatedCve) || 0;
  const monthsWithUnallocated = Math.max(1, Number(unallocated.monthsWithUnallocated) || 0);
  const avgMonthlyOpex = totalExpensesCve / monthsWithExpenses;
  const avgMonthlyUnallocated = totalUnallocatedCve / monthsWithUnallocated;

  const activeRows = investmentRows.filter((r) => ACTIVE_INVESTMENT_STATUSES.has(r.status));
  const totalInstalledActive = activeRows.reduce((sum, r) => sum + (Number(r.installedClients) || 0), 0);
  const totalInstalledUnlinkedActive = activeRows
    .filter((r) => r.clientId == null && !r.zone)
    .reduce((sum, r) => sum + (Number(r.installedClients) || 0), 0);
  const opexPerClientPerMonth = totalInstalledActive > 0 ? avgMonthlyUnallocated / totalInstalledActive : 0;

  // Divisores para OPEX direto partilhado: todos os investimentos que apontam
  // para a mesma zona/cliente dividem a despesa entre si (senão cada um
  // absorvia 100% e o agregado contava a mesma despesa N vezes).
  const sharersByZone: Record<string, number> = {};
  const sharersByClient: Record<number, number> = {};
  for (const r of investmentRows) {
    if (r.zone) sharersByZone[r.zone] = (sharersByZone[r.zone] || 0) + 1;
    if (r.clientId != null) sharersByClient[r.clientId] = (sharersByClient[r.clientId] || 0) + 1;
  }

  const directByInvestment: Record<number, number> = {};
  const directByZone: Record<string, number> = {};
  const directByClient: Record<number, number> = {};
  const directTotalsByInvestment: Record<number, number> = {};
  const directTotalsByZone: Record<string, number> = {};
  const directTotalsByClient: Record<number, number> = {};
  let totalAllocatedCve = 0;
  for (const row of directRows) {
    const total = Number(row.totalCve);
    const monthly = total / Math.max(1, Number(row.months) || 1);
    totalAllocatedCve += total;
    if (row.investmentId != null) {
      directByInvestment[row.investmentId] = (directByInvestment[row.investmentId] || 0) + monthly;
      directTotalsByInvestment[row.investmentId] = (directTotalsByInvestment[row.investmentId] || 0) + total;
    } else if (row.clientId != null) {
      directByClient[row.clientId] = (directByClient[row.clientId] || 0) + monthly;
      directTotalsByClient[row.clientId] = (directTotalsByClient[row.clientId] || 0) + total;
    } else if (row.zone) {
      directByZone[row.zone] = (directByZone[row.zone] || 0) + monthly;
      directTotalsByZone[row.zone] = (directTotalsByZone[row.zone] || 0) + total;
    }
  }

  return {
    totalExpensesCve,
    totalAllocatedCve,
    totalUnallocatedCve,
    monthsWithExpenses,
    monthsWithUnallocated,
    avgMonthlyOpex,
    avgMonthlyUnallocated,
    totalInstalledActive,
    totalInstalledUnlinkedActive,
    opexPerClientPerMonth,
    directByInvestment,
    directByZone,
    directByClient,
    directTotalsByInvestment,
    directTotalsByZone,
    directTotalsByClient,
    sharersByZone,
    sharersByClient
  };
}

/**
 * Average actual monthly revenue derived from paid payments of the clients
 * tied to an investment. Targets are resolved in this order:
 *
 *   1. explicit `client_id` on the investment
 *   2. explicit `zone` on the investment (sums all clients in that zone)
 *   3. neither → returns null so the caller can fall back to the manual
 *      `expected_monthly_revenue_cve`
 */
export function loadActualMonthlyRevenue(target: { clientId: number | null; zone: string | null }): {
  cve: number;
  source: 'client' | 'zone';
  months: number;
} | null {
  const db = getSqliteDatabase();
  if (target.clientId != null) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount_cve), 0) AS totalCve,
             COUNT(DISTINCT reference_month) AS months
      FROM payments
      WHERE client_id = ? AND status = 'paid'
    `).get(target.clientId) as { totalCve: number; months: number };
    const months = Math.max(0, Number(row.months) || 0);
    if (months === 0) return null;
    return { cve: Number(row.totalCve) / months, source: 'client', months };
  }
  if (target.zone) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(py.amount_cve), 0) AS totalCve,
             COUNT(DISTINCT py.reference_month) AS months
      FROM payments py
      JOIN clients c ON c.id = py.client_id
      WHERE c.zone = ? AND py.status = 'paid'
    `).get(target.zone) as { totalCve: number; months: number };
    const months = Math.max(0, Number(row.months) || 0);
    if (months === 0) return null;
    return { cve: Number(row.totalCve) / months, source: 'zone', months };
  }
  return null;
}
