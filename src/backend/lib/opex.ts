import { getSqliteDatabase } from '../db/database';
import { cashReceiptFilterSql } from './payments';

/**
 * Pro-rata OPEX context, with direct allocation support.
 *
 * Expense rows can optionally pin themselves to one specific target via
 * `investment_id`, `zone`, or `client_id`. When set, the amount is attributed
 * 100% to that target and excluded from the company-wide pool. Whatever
 * remains (no target) is spread by client:
 *
 *   unallocatedAvg/m = SUM(unallocated.amount) / meses de calendário MIN..MAX
 *   opexPerClient/m  = unallocatedAvg / rateioDenominator
 *
 * Médias por SPAN de calendário (não por "meses com registos"): registar
 * despesas de 3 em 3 meses já não triplica o run-rate — os meses vazios no
 * meio contam. O denominador do rateio é a contagem REAL de serviços ativos
 * (fallback: installed_clients dos investimentos, mantido à mão, quando ainda
 * não há serviços).
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
  /** Denominador do rateio: serviços ativos reais; fallback installed_clients. */
  rateioDenominator: number;
  /** Despesas não-alocadas por mês (AAAA-MM) — para OPEX imputado exato na recuperação/timeline. */
  unallocatedByMonth: Record<string, number>;
  /** Clientes reclamados por cada investimento (client_id legado ∪ investment_clients). */
  claimsByInvestment: Record<number, number[]>;
};

export const ACTIVE_INVESTMENT_STATUSES = new Set(['ativo', 'em_execucao', 'recuperado']);

/** Meses de calendário entre dois AAAA-MM, inclusive (mín. 1). */
export function monthsSpanInclusive(startMonth: string | null, endMonth: string | null): number {
  if (!startMonth || !endMonth) return 1;
  const [sy, sm] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
  return Math.max(1, (ey - sy) * 12 + (em - sm) + 1);
}

type DirectRow = {
  investmentId: number | null;
  zone: string | null;
  clientId: number | null;
  totalCve: number;
  firstMonth: string | null;
  lastMonth: string | null;
};

export function loadCompanyOpexContext(): CompanyOpexContext {
  const db = getSqliteDatabase();

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(amount_cve), 0) AS totalExpensesCve,
      MIN(reference_month) AS firstMonth,
      MAX(reference_month) AS lastMonth
    FROM expenses
  `).get() as { totalExpensesCve: number; firstMonth: string | null; lastMonth: string | null };

  const unallocated = db.prepare(`
    SELECT
      COALESCE(SUM(amount_cve), 0) AS totalUnallocatedCve,
      MIN(reference_month) AS firstMonth,
      MAX(reference_month) AS lastMonth
    FROM expenses
    WHERE investment_id IS NULL AND zone IS NULL AND client_id IS NULL
  `).get() as { totalUnallocatedCve: number; firstMonth: string | null; lastMonth: string | null };

  const unallocatedByMonth: Record<string, number> = {};
  for (const r of db.prepare(`
    SELECT reference_month AS m, COALESCE(SUM(amount_cve), 0) AS cve
    FROM expenses
    WHERE investment_id IS NULL AND zone IS NULL AND client_id IS NULL
    GROUP BY reference_month
  `).all() as Array<{ m: string; cve: number }>) {
    unallocatedByMonth[r.m] = Number(r.cve) || 0;
  }

  const directRows = db.prepare(`
    SELECT
      investment_id AS investmentId,
      zone,
      client_id AS clientId,
      COALESCE(SUM(amount_cve), 0) AS totalCve,
      MIN(reference_month) AS firstMonth,
      MAX(reference_month) AS lastMonth
    FROM expenses
    WHERE investment_id IS NOT NULL OR zone IS NOT NULL OR client_id IS NOT NULL
    GROUP BY investment_id, zone, client_id
  `).all() as DirectRow[];

  const investmentRows = db.prepare(`
    SELECT id, installed_clients AS installedClients, status, client_id AS clientId, zone FROM investments
  `).all() as Array<{ id: number; installedClients: number; status: string; clientId: number | null; zone: string | null }>;

  // client_id legado ∪ tabela de junção — o conjunto de clientes de cada investimento.
  const junctionRows = db.prepare(`
    SELECT investment_id AS investmentId, client_id AS clientId FROM investment_clients
  `).all() as Array<{ investmentId: number; clientId: number }>;
  const claimsByInvestment: Record<number, number[]> = {};
  const addClaim = (invId: number, clientId: number) => {
    const list = claimsByInvestment[invId] ?? (claimsByInvestment[invId] = []);
    if (!list.includes(clientId)) list.push(clientId);
  };
  for (const r of junctionRows) addClaim(r.investmentId, r.clientId);
  for (const r of investmentRows) if (r.clientId != null) addClaim(r.id, r.clientId);

  const totalExpensesCve = Number(totals.totalExpensesCve) || 0;
  const monthsWithExpenses = monthsSpanInclusive(totals.firstMonth, totals.lastMonth);

  const totalUnallocatedCve = Number(unallocated.totalUnallocatedCve) || 0;
  const monthsWithUnallocated = monthsSpanInclusive(unallocated.firstMonth, unallocated.lastMonth);
  const avgMonthlyOpex = totalExpensesCve / monthsWithExpenses;
  const avgMonthlyUnallocated = totalUnallocatedCve / monthsWithUnallocated;

  const activeRows = investmentRows.filter((r) => ACTIVE_INVESTMENT_STATUSES.has(r.status));
  const totalInstalledActive = activeRows.reduce((sum, r) => sum + (Number(r.installedClients) || 0), 0);
  const totalInstalledUnlinkedActive = activeRows
    .filter((r) => !(claimsByInvestment[r.id]?.length) && !r.zone)
    .reduce((sum, r) => sum + (Number(r.installedClients) || 0), 0);
  // Denominador REAL: serviços ativos (26 clientes reais valem mais do que o
  // installed_clients manual dos investimentos, que deriva). Fallback para a
  // base instalada declarada quando ainda não há serviços registados.
  const servicesActive = Number((db.prepare(`SELECT COUNT(*) AS n FROM services WHERE status = 'active'`)
    .get() as { n: number }).n) || 0;
  const rateioDenominator = servicesActive > 0 ? servicesActive : totalInstalledActive;
  const opexPerClientPerMonth = rateioDenominator > 0 ? avgMonthlyUnallocated / rateioDenominator : 0;

  // Divisores para OPEX direto partilhado: todos os investimentos que apontam
  // para a mesma zona/cliente dividem a despesa entre si (senão cada um
  // absorvia 100% e o agregado contava a mesma despesa N vezes).
  const sharersByZone: Record<string, number> = {};
  const sharersByClient: Record<number, number> = {};
  for (const r of investmentRows) {
    if (r.zone) sharersByZone[r.zone] = (sharersByZone[r.zone] || 0) + 1;
  }
  for (const [, clientIds] of Object.entries(claimsByInvestment)) {
    for (const clientId of clientIds) {
      sharersByClient[clientId] = (sharersByClient[clientId] || 0) + 1;
    }
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
    const monthly = total / monthsSpanInclusive(row.firstMonth, row.lastMonth);
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
    sharersByClient,
    rateioDenominator,
    unallocatedByMonth,
    claimsByInvestment
  };
}

/**
 * Atribuição de receita paga por investimento — waterfall por cliente:
 *
 *   1. cliente reclamado diretamente (client_id ∪ investment_clients) →
 *      a receita dele divide-se pelos investimentos que o reclamam;
 *   2. senão, cliente numa zona com investimentos → divide-se pelos
 *      investimentos dessa zona;
 *   3. senão → pool não-atribuído (global-share por installed_clients).
 *
 * Cada escudo pago entra exatamente uma vez — a soma da receita atribuída
 * nunca excede a receita real da empresa.
 */
export type RevenueAttribution = {
  byInvestment: Record<number, { monthlyCve: number; totalCve: number; months: number; source: 'client' | 'zone' }>;
  unattributedMonthlyCve: number;
};

export function loadRevenueAttribution(opexCtx: CompanyOpexContext): RevenueAttribution {
  const db = getSqliteDatabase();

  const investmentRows = db.prepare(`SELECT id, zone FROM investments`).all() as Array<{ id: number; zone: string | null }>;
  const invsByZone: Record<string, number[]> = {};
  for (const r of investmentRows) {
    if (r.zone) (invsByZone[r.zone] ?? (invsByZone[r.zone] = [])).push(r.id);
  }
  const invsByClient: Record<number, number[]> = {};
  for (const [invId, clientIds] of Object.entries(opexCtx.claimsByInvestment)) {
    for (const clientId of clientIds) {
      (invsByClient[clientId] ?? (invsByClient[clientId] = [])).push(Number(invId));
    }
  }

  // Caixa, nao faturas fechadas: uma fatura de 50.000$ com 10.000$ entregues
  // pesa 10.000$: antes dos recibos parciais pesava zero ate ao dia em que
  // fechasse, e nesse dia pesava 50.000$ no mes da competencia. O mes vem do
  // `payment_date` — o dinheiro conta quando entra, nao quando foi faturado.
  const clientRows = db.prepare(`
    SELECT py.client_id AS clientId, c.zone,
           COALESCE(SUM(r.amount_cve), 0) AS totalCve,
           MIN(substr(r.payment_date, 1, 7)) AS firstMonth,
           MAX(substr(r.payment_date, 1, 7)) AS lastMonth
    FROM payment_receipts r
    JOIN payments py ON py.id = r.payment_id
    JOIN clients c ON c.id = py.client_id
    WHERE ${cashReceiptFilterSql('r')}
    GROUP BY py.client_id
  `).all() as Array<{ clientId: number; zone: string | null; totalCve: number; firstMonth: string; lastMonth: string }>;

  const acc: Record<number, { totalCve: number; firstMonth: string; lastMonth: string; source: 'client' | 'zone' }> = {};
  const credit = (invId: number, share: number, row: { firstMonth: string; lastMonth: string }, source: 'client' | 'zone') => {
    const cur = acc[invId];
    if (!cur) {
      acc[invId] = { totalCve: share, firstMonth: row.firstMonth, lastMonth: row.lastMonth, source };
      return;
    }
    cur.totalCve += share;
    if (row.firstMonth < cur.firstMonth) cur.firstMonth = row.firstMonth;
    if (row.lastMonth > cur.lastMonth) cur.lastMonth = row.lastMonth;
    // Claims diretos dominam a proveniência quando há mistura zona+clientes.
    if (source === 'client') cur.source = 'client';
  };

  let poolCve = 0;
  let poolFirst: string | null = null;
  let poolLast: string | null = null;
  for (const row of clientRows) {
    const total = Number(row.totalCve) || 0;
    const direct = invsByClient[row.clientId];
    if (direct?.length) {
      for (const invId of direct) credit(invId, total / direct.length, row, 'client');
      continue;
    }
    const zoned = row.zone ? invsByZone[row.zone] : undefined;
    if (zoned?.length) {
      for (const invId of zoned) credit(invId, total / zoned.length, row, 'zone');
      continue;
    }
    poolCve += total;
    if (!poolFirst || row.firstMonth < poolFirst) poolFirst = row.firstMonth;
    if (!poolLast || row.lastMonth > poolLast) poolLast = row.lastMonth;
  }

  const byInvestment: RevenueAttribution['byInvestment'] = {};
  for (const [invId, entry] of Object.entries(acc)) {
    if (entry.totalCve <= 0) continue;
    const months = monthsSpanInclusive(entry.firstMonth, entry.lastMonth);
    byInvestment[Number(invId)] = {
      monthlyCve: entry.totalCve / months,
      totalCve: entry.totalCve,
      months,
      source: entry.source
    };
  }

  return {
    byInvestment,
    unattributedMonthlyCve: poolCve > 0 ? poolCve / monthsSpanInclusive(poolFirst, poolLast) : 0
  };
}

export type InvestmentBaseRow = {
  id: number;
  totalCostCve: number;
  expectedMonthlyRevenueCve: number;
  monthlyOperationalCostCve: number;
  accumulatedRevenueCve: number;
  targetClients: number;
  installedClients: number;
  desiredPaybackMonths: number;
  desiredMarginPct: number;
  clientId: number | null;
  zone: string | null;
  investmentDate: string;
};

/**
 * Metricas derivadas de um investimento — a UNICA definicao. Vive aqui e nao na
 * rota porque o PDF/XLSX de rentabilidade calculava a sua propria versao a
 * partir da receita ESPERADA: dois numeros com o mesmo nome, o do ecra e o do
 * ficheiro, e nenhuma maneira de saber qual estava certo.
 */
export function profitability(row: InvestmentBaseRow, opexCtx: CompanyOpexContext, revenueAttr: RevenueAttribution) {
  const activeClients = Math.max(1, row.installedClients || row.targetClients || 1);
  const targetClients = Math.max(1, row.targetClients || 1);
  const imputedMonthlyOpexCve = opexCtx.opexPerClientPerMonth * (Number(row.installedClients) || 0);
  // OPEX direto de zona/cliente é dividido pelos investimentos que o partilham —
  // sem o divisor, dois investimentos na mesma zona absorviam cada um 100% da
  // mesma despesa e o agregado contava-a duas vezes. Os clientes reclamados
  // vêm do conjunto completo (client_id legado ∪ investment_clients).
  const claimedClients = opexCtx.claimsByInvestment[row.id] ?? [];
  const zoneSharers = row.zone ? Math.max(1, opexCtx.sharersByZone[row.zone] || 1) : 1;
  const clientShareOf = (map: Record<number, number>) =>
    claimedClients.reduce(
      (sum, clientId) => sum + (map[clientId] || 0) / Math.max(1, opexCtx.sharersByClient[clientId] || 1),
      0
    );
  const directAllocatedOpexCve =
    (opexCtx.directByInvestment[row.id] || 0)
    + clientShareOf(opexCtx.directByClient)
    + (row.zone ? (opexCtx.directByZone[row.zone] || 0) / zoneSharers : 0);
  const effectiveMonthlyOpexCve =
    (Number(row.monthlyOperationalCostCve) || 0) + imputedMonthlyOpexCve + directAllocatedOpexCve;

  // Receita atribuída pelo waterfall (clientes reclamados > zona > pool) —
  // cada escudo pago entra exatamente uma vez em toda a carteira.
  const attributed = revenueAttr.byInvestment[row.id] ?? null;
  const canUseGlobalShare =
    attributed === null
    && claimedClients.length === 0
    && (!row.zone)
    && opexCtx.totalInstalledUnlinkedActive > 0
    && (Number(row.installedClients) || 0) > 0
    && revenueAttr.unattributedMonthlyCve > 0;
  const globalShareCve = canUseGlobalShare
    ? revenueAttr.unattributedMonthlyCve * ((Number(row.installedClients) || 0) / opexCtx.totalInstalledUnlinkedActive)
    : null;

  const actualMonthlyRevenueCve = attributed?.monthlyCve ?? globalShareCve;
  const revenueSource: 'client' | 'zone' | 'global-share' | null =
    attributed?.source ?? (globalShareCve !== null ? 'global-share' : null);
  const revenueVarianceCve = actualMonthlyRevenueCve != null
    ? actualMonthlyRevenueCve - row.expectedMonthlyRevenueCve
    : null;
  const monthlyRevenueForRoi = actualMonthlyRevenueCve != null
    ? actualMonthlyRevenueCve
    : row.expectedMonthlyRevenueCve;

  const monthlyNetProfitCve = monthlyRevenueForRoi - effectiveMonthlyOpexCve;
  const costPerClientCve = row.totalCostCve / targetClients;
  const operationalCostPerClientCve = effectiveMonthlyOpexCve / activeClients;
  const baseRecoveryPrice = costPerClientCve / Math.max(1, row.desiredPaybackMonths || 1);
  const recommendedPlanCve = (baseRecoveryPrice + operationalCostPerClientCve)
    * (1 + Math.max(0, row.desiredMarginPct || 0) / 100);

  // Recuperação — UMA definição, a mesma da timeline: receita real acumulada
  // (pagamentos do cliente/zona) menos OPEX acumulado (direto + imputado das
  // despesas REAIS desde o início do investimento) menos o capital. A "Receita
  // acumulada" manual só entra como fallback sem cliente/zona com pagamentos.
  const startMonth = row.investmentDate.slice(0, 7);
  const actualAccumulatedRevenueCve = attributed !== null ? attributed.totalCve : null;
  const accumulatedRevenueBaseCve = actualAccumulatedRevenueCve ?? (Number(row.accumulatedRevenueCve) || 0);
  // Imputado exato: despesas não-alocadas dos meses >= início, rateadas — não
  // uma média retroativa que cobrava OPEX de meses em que ele não existiu.
  const accumulatedImputedCve = opexCtx.rateioDenominator > 0
    ? (Object.entries(opexCtx.unallocatedByMonth)
        .filter(([month]) => month >= startMonth)
        .reduce((sum, [, cve]) => sum + cve, 0) / opexCtx.rateioDenominator)
      * (Number(row.installedClients) || 0)
    : 0;
  const accumulatedOpexCve =
    (opexCtx.directTotalsByInvestment[row.id] || 0)
    + clientShareOf(opexCtx.directTotalsByClient)
    + (row.zone ? (opexCtx.directTotalsByZone[row.zone] || 0) / zoneSharers : 0)
    + accumulatedImputedCve;
  const accumulatedProfitCve = accumulatedRevenueBaseCve - accumulatedOpexCve - row.totalCostCve;

  return {
    costPerClientCve,
    operationalCostPerClientCve,
    recommendedPlanCve,
    imputedMonthlyOpexCve,
    directAllocatedOpexCve,
    effectiveMonthlyOpexCve,
    actualMonthlyRevenueCve,
    revenueSource,
    revenueVarianceCve,
    monthlyNetProfitCve,
    accumulatedProfitCve,
    accumulatedOpexCve,
    accumulatedRevenueSource: actualAccumulatedRevenueCve !== null ? 'payments' as const : 'manual' as const,
    recoveryMonths: monthlyNetProfitCve > 0 ? row.totalCostCve / monthlyNetProfitCve : null,
    roiPct: row.totalCostCve > 0 ? (accumulatedProfitCve / row.totalCostCve) * 100 : null,
    // ROI anual convencional: retorno líquido anualizado sobre o capital.
    // (A antiga fórmula subtraía o capex ao fluxo — dava −100% com lucro zero.)
    annualRoiPct: row.totalCostCve > 0 ? ((monthlyNetProfitCve * 12) / row.totalCostCve) * 100 : null,
    isRecovered: accumulatedProfitCve >= 0
  };
}
