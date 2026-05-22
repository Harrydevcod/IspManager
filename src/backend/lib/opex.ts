import { getSqliteDatabase } from '../db/database';

/**
 * Pro-rata OPEX context computed at query time.
 *
 *   avgMonthlyOpex     = SUM(expenses.amount_cve) / months_with_data (>=1)
 *   opexPerClient/m    = avgMonthlyOpex / SUM(installed_clients of active investments)
 *
 * Active investments are those whose status is in ACTIVE_INVESTMENT_STATUSES.
 * Both the investments route and the client profitability endpoint use this
 * single source of truth so the math stays consistent across the app.
 */
export type CompanyOpexContext = {
  totalExpensesCve: number;
  monthsWithExpenses: number;
  avgMonthlyOpex: number;
  totalInstalledActive: number;
  opexPerClientPerMonth: number;
};

export const ACTIVE_INVESTMENT_STATUSES = new Set(['ativo', 'em_execucao', 'recuperado']);

export function loadCompanyOpexContext(): CompanyOpexContext {
  const db = getSqliteDatabase();
  const expensesRow = db.prepare(`
    SELECT
      COALESCE(SUM(amount_cve), 0) AS totalExpensesCve,
      COUNT(DISTINCT reference_month) AS monthsWithExpenses
    FROM expenses
  `).get() as { totalExpensesCve: number; monthsWithExpenses: number };

  const totalExpensesCve = Number(expensesRow.totalExpensesCve) || 0;
  const monthsWithExpenses = Math.max(1, Number(expensesRow.monthsWithExpenses) || 0);
  const avgMonthlyOpex = totalExpensesCve / monthsWithExpenses;

  const investmentRows = db.prepare(`
    SELECT installed_clients AS installedClients, status FROM investments
  `).all() as Array<{ installedClients: number; status: string }>;

  const totalInstalledActive = investmentRows
    .filter((r) => ACTIVE_INVESTMENT_STATUSES.has(r.status))
    .reduce((sum, r) => sum + (Number(r.installedClients) || 0), 0);
  const opexPerClientPerMonth = totalInstalledActive > 0 ? avgMonthlyOpex / totalInstalledActive : 0;

  return { totalExpensesCve, monthsWithExpenses, avgMonthlyOpex, totalInstalledActive, opexPerClientPerMonth };
}
