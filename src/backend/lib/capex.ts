import { getSqliteDatabase } from '../db/database';
import { loadCompanyOpexContext, type CompanyOpexContext } from './opex';

/**
 * Capital: uma definicao so, para nenhum painel inventar a sua.
 *
 * O custo aterrado de um modelo — o que ele custou a por no armazem, incluindo
 * o que se pagou para la chegar. Vive aqui porque cinco ficheiros o escreviam
 * a mao e bastava um esquecer o frete para dois ecras discordarem.
 */
export const LANDED_COST_SQL =
  '(purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve)';

/** O mesmo custo aterrado, qualificado por um alias de `equipment_catalog`. */
export function landedCostSql(alias = 'ec'): string {
  return `(${alias}.purchase_price_cve + ${alias}.shipping_cost_cve`
    + ` + ${alias}.customs_duty_cve + ${alias}.other_costs_cve)`;
}

/**
 * Capital aplicado em stock: a soma das COMPRAS.
 *
 * A conta antiga somava o saldo atual mais as saidas historicas, e partia do
 * principio de que uma unidade que sai do armazem nunca la volta. Volta —
 * devolucao, transferencia de titular, troca, retirada de backbone. Cada
 * regresso repunha `stock_total` sem anular a saida que lhe deu origem, e a
 * mesma unidade passava a contar duas vezes, para sempre.
 *
 * Somar entradas nao tem esse problema: uma devolucao nao e uma compra, logo
 * nao conta. O erro morre por construcao, e cada escudo fica com a data em que
 * saiu da conta — que e o que poe o stock no grafico por ano.
 */
export function stockCapexSql(alias = 'm'): string {
  return `${alias}.type = 'entrada'`;
}

export function stockCapexCve(): number {
  const row = getSqliteDatabase().prepare(`
    SELECT COALESCE(SUM(m.quantity * m.unit_cost_cve), 0) AS totalCve
    FROM stock_movements m
    WHERE ${stockCapexSql('m')}
  `).get() as { totalCve: number };
  return Number(row.totalCve) || 0;
}

/** Capital de stock por ano civil da compra — para o grafico casar com o KPI. */
export function stockCapexByYear(): Array<{ year: string; capexCve: number }> {
  const rows = getSqliteDatabase().prepare(`
    SELECT substr(m.created_at, 1, 4) AS year,
           COALESCE(SUM(m.quantity * m.unit_cost_cve), 0) AS capexCve
    FROM stock_movements m
    WHERE ${stockCapexSql('m')}
    GROUP BY year
  `).all() as Array<{ year: string; capexCve: number }>;
  return rows.map((r) => ({ year: r.year, capexCve: Number(r.capexCve) || 0 }));
}

/**
 * Custo externo dos investimentos: as linhas que NAO sao equipamento do
 * catalogo — mao de obra, poste, licenca, aluguer de grua.
 *
 * Uma linha com `catalog_id` preenchido nao soma: esse equipamento ja contou
 * quando deu entrada no armazem. O investimento apenas o agrupa sob uma
 * intencao. Sem esta regra, quem comprasse seis CPE e depois registasse o
 * investimento "Expansao Achada" pagava-os duas vezes no relatorio.
 *
 * Investimentos sem itens caem no `total_cost_cve` declarado — e o historico
 * todo, escrito antes de haver itens ligados ao catalogo.
 */
export function externalInvestmentCapexSql(alias = 'i'): string {
  return `
    CASE WHEN EXISTS (SELECT 1 FROM investment_items it WHERE it.investment_id = ${alias}.id)
      THEN COALESCE((
        SELECT SUM(it.total_cost_cve) FROM investment_items it
        WHERE it.investment_id = ${alias}.id AND it.catalog_id IS NULL
      ), 0)
      ELSE ${alias}.total_cost_cve
    END`;
}

export function externalInvestmentCapexCve(): number {
  const row = getSqliteDatabase().prepare(`
    SELECT COALESCE(SUM(${externalInvestmentCapexSql('i')}), 0) AS totalCve FROM investments i
  `).get() as { totalCve: number };
  return Number(row.totalCve) || 0;
}

/**
 * Parque instalado: quanto vale hoje o que esta nos telhados.
 *
 * Linha reta sobre a vida util do modelo, a partir da data de instalacao. Conta
 * a unidade fisica: uma antena que serve tres servicos e uma antena. O rateio
 * pelas partilhas pertence a carteira, onde a pergunta e por cliente.
 *
 * ponytail: linha reta sem valor residual. Se um dia interessar distinguir o
 * que se vende em segunda mao do que vai para o lixo, entra um `residual_pct`
 * no catalogo e muda-se so a expressao aqui.
 */
const DEPRECIATION_FACTOR_SQL = `
  max(0.0, 1.0 - ((julianday('now') - julianday(a.start_date)) / 30.44)
                 / max(1.0, ec.useful_life_months))`;

/** Partilhas de uma atribuicao: uma antena de predio serve N servicos. */
const SHARES_JOIN_SQL = `
  JOIN (SELECT assignment_id, COUNT(*) AS n FROM assignment_services GROUP BY assignment_id) sh
    ON sh.assignment_id = a.id`;

export function parkValue(): { netValueCve: number; monthlyDepreciationCve: number; units: number } {
  // Sem rateio: aqui parte-se da atribuicao, que ja e a unidade fisica. O
  // rateio pelas partilhas so pertence a carteira, onde se conta por cliente.
  const row = getSqliteDatabase().prepare(`
    SELECT
      COALESCE(SUM(${landedCostSql('ec')} * ${DEPRECIATION_FACTOR_SQL}), 0) AS netValueCve,
      COALESCE(SUM(${landedCostSql('ec')} / max(1.0, ec.useful_life_months)), 0)
        AS monthlyDepreciationCve,
      COUNT(*) AS units
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    WHERE a.end_date IS NULL
  `).get() as { netValueCve: number; monthlyDepreciationCve: number; units: number };
  return {
    netValueCve: Number(row.netValueCve) || 0,
    monthlyDepreciationCve: Number(row.monthlyDepreciationCve) || 0,
    units: Number(row.units) || 0
  };
}

export type PortfolioRow = {
  clientId: number;
  clientCode: string;
  fullName: string;
  zone: string | null;
  island: string | null;
  status: string;
  /** Capital aplicado neste cliente: equipamento + material + mao de obra + investimentos seus. */
  installationCostCve: number;
  installedEquipmentCostCve: number;
  installedMaterialsCostCve: number;
  installLabourCostCve: number;
  investmentCostCve: number;
  /** Depreciacao mensal do equipamento que ainda la esta. */
  monthlyDepreciationCve: number;
  paidRevenueCve: number;
  monthlyAverageRevenueCve: number;
  effectiveMonthlyOpexCve: number;
  monthlyNetProfitCve: number;
  /** Margem mensal ja com o desgaste do equipamento — a que se compara entre clientes. */
  monthlyMarginCve: number;
  cumulativeOpexCve: number;
  netProfitCve: number;
  remainingCapitalCve: number;
  monthsToBreakeven: number | null;
  profitabilityPct: number | null;
  isRecovered: boolean;
  monthsActive: number;
};

/** Agregado por cliente, opcionalmente limitado a um conjunto de ids. */
function sumByClient(sql: string, clientIds?: number[]): Record<number, number> {
  const scoped = clientIds?.length
    ? sql.replace('/*SCOPE*/', `AND s.client_id IN (${clientIds.map(() => '?').join(',')})`)
    : sql.replace('/*SCOPE*/', '');
  const rows = getSqliteDatabase().prepare(scoped)
    .all(...(clientIds ?? [])) as Array<{ clientId: number; totalCve: number }>;
  const out: Record<number, number> = {};
  for (const r of rows) out[r.clientId] = Number(r.totalCve) || 0;
  return out;
}

/**
 * A carteira: cada cliente, o capital que leva e o que ja devolveu.
 *
 * A mesma conta que a ficha do cliente fazia sozinha — mudou de sitio para a
 * lista e a ficha nao poderem dar numeros diferentes sobre o mesmo cliente.
 * Sem argumento devolve a carteira toda; com ids, so esses.
 */
export function portfolioRows(clientIds?: number[], ctx?: CompanyOpexContext): PortfolioRow[] {
  const db = getSqliteDatabase();
  const opexCtx = ctx ?? loadCompanyOpexContext();
  const ids = clientIds?.length ? clientIds : undefined;
  const scope = ids ? `WHERE c.id IN (${ids.map(() => '?').join(',')})` : '';
  const args = ids ?? [];

  const clients = db.prepare(`
    SELECT c.id, c.client_code AS clientCode, c.full_name AS fullName, c.zone, c.island, c.status
    FROM clients c ${scope} ORDER BY c.full_name ASC
  `).all(...args) as Array<{
    id: number; clientCode: string; fullName: string;
    zone: string | null; island: string | null; status: string;
  }>;
  if (clients.length === 0) return [];

  const landed = landedCostSql('ec');

  // Rateio pelas partilhas: uma antena que serve N servicos custa 1/N a cada um,
  // e a soma sobre a carteira da o equipamento exatamente uma vez. O capital
  // conta o equipamento ja retirado — foi dinheiro aplicado neste cliente.
  const equipment = sumByClient(`
    SELECT s.client_id AS clientId, SUM(${landed} * 1.0 / sh.n) AS totalCve
    FROM assignment_services asv
    JOIN service_device_assignments a ON a.id = asv.assignment_id
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    JOIN services s ON s.id = asv.service_id
    ${SHARES_JOIN_SQL}
    WHERE 1 = 1 /*SCOPE*/
    GROUP BY s.client_id
  `, ids);

  // A depreciacao so olha para o que ainda la esta.
  const depreciation = sumByClient(`
    SELECT s.client_id AS clientId,
           SUM(${landed} / max(1.0, ec.useful_life_months) / sh.n) AS totalCve
    FROM assignment_services asv
    JOIN service_device_assignments a ON a.id = asv.assignment_id
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    JOIN services s ON s.id = asv.service_id
    ${SHARES_JOIN_SQL}
    WHERE a.end_date IS NULL /*SCOPE*/
    GROUP BY s.client_id
  `, ids);

  const materials = sumByClient(`
    SELECT s.client_id AS clientId, SUM(ml.quantity * ml.unit_cost_cve) AS totalCve
    FROM service_material_lines ml
    JOIN services s ON s.id = ml.service_id
    WHERE 1 = 1 /*SCOPE*/
    GROUP BY s.client_id
  `, ids);

  const labour = sumByClient(`
    SELECT s.client_id AS clientId, SUM(ic.amount_cve) AS totalCve
    FROM service_install_costs ic
    JOIN services s ON s.id = ic.service_id
    WHERE 1 = 1 /*SCOPE*/
    GROUP BY s.client_id
  `, ids);

  const investmentScope = ids ? `AND i.client_id IN (${ids.map(() => '?').join(',')})` : '';
  const investments: Record<number, number> = {};
  const investmentRows = db.prepare(`
    SELECT i.client_id AS clientId, SUM(${externalInvestmentCapexSql('i')}) AS totalCve
    FROM investments i WHERE i.client_id IS NOT NULL ${investmentScope}
    GROUP BY i.client_id
  `).all(...args) as Array<{ clientId: number; totalCve: number }>;
  for (const r of investmentRows) investments[r.clientId] = Number(r.totalCve) || 0;

  // Despesa afeta a um investimento deste cliente e OPEX deste cliente.
  const investmentOpex: Record<number, number> = {};
  const investmentIdRows = db.prepare(`
    SELECT i.id, i.client_id AS clientId FROM investments i
    WHERE i.client_id IS NOT NULL ${investmentScope}
  `).all(...args) as Array<{ id: number; clientId: number }>;
  for (const r of investmentIdRows) {
    investmentOpex[r.clientId] =
      (investmentOpex[r.clientId] || 0) + (opexCtx.directByInvestment[r.id] || 0);
  }

  // Caixa e meses: o recebido sai dos recibos, nao do valor cheio da fatura —
  // uma fatura meio paga pesa o que entrou. Faturas anuladas nao contam.
  const paymentScope = ids ? `AND p.client_id IN (${ids.map(() => '?').join(',')})` : '';
  const revenue: Record<number, { paidCve: number; monthsActive: number; paidMonths: number }> = {};
  const revenueRows = db.prepare(`
    SELECT p.client_id AS clientId,
           COALESCE(SUM(CASE WHEN p.status <> 'cancelled' THEN (
             SELECT COALESCE(SUM(r.amount_cve), 0) FROM payment_receipts r
             WHERE r.payment_id = p.id AND r.voided_at IS NULL
           ) ELSE 0 END), 0) AS paidCve,
           COUNT(DISTINCT p.reference_month) AS monthsActive,
           COUNT(DISTINCT CASE WHEN p.status = 'paid' THEN p.reference_month END) AS paidMonths
    FROM payments p WHERE 1 = 1 ${paymentScope}
    GROUP BY p.client_id
  `).all(...args) as Array<{
    clientId: number; paidCve: number; monthsActive: number; paidMonths: number;
  }>;
  for (const r of revenueRows) {
    revenue[r.clientId] = {
      paidCve: Number(r.paidCve) || 0,
      monthsActive: Number(r.monthsActive) || 0,
      paidMonths: Number(r.paidMonths) || 0
    };
  }

  const zoneActive: Record<string, number> = {};
  const zoneRows = db.prepare(`
    SELECT zone, COUNT(*) AS n FROM clients
    WHERE status = 'active' AND zone IS NOT NULL GROUP BY zone
  `).all() as Array<{ zone: string; n: number }>;
  for (const r of zoneRows) zoneActive[r.zone] = Number(r.n) || 0;

  return clients.map((c) => {
    const installedEquipmentCostCve = equipment[c.id] || 0;
    const installedMaterialsCostCve = materials[c.id] || 0;
    const installLabourCostCve = labour[c.id] || 0;
    const investmentCostCve = investments[c.id] || 0;
    const installationCostCve = investmentCostCve
      + installedEquipmentCostCve + installedMaterialsCostCve + installLabourCostCve;
    const monthlyDepreciationCve = depreciation[c.id] || 0;

    const rev = revenue[c.id] ?? { paidCve: 0, monthsActive: 0, paidMonths: 0 };
    const monthlyAverageRevenueCve = rev.paidMonths > 0 ? rev.paidCve / rev.paidMonths : 0;

    const directZoneOpexCve = c.zone ? (opexCtx.directByZone[c.zone] || 0) : 0;
    const zoneCount = c.zone ? (zoneActive[c.zone] || 0) : 0;
    const effectiveMonthlyOpexCve =
      opexCtx.opexPerClientPerMonth
      + (opexCtx.directByClient[c.id] || 0)
      + (zoneCount > 0 ? directZoneOpexCve / zoneCount : 0)
      + (investmentOpex[c.id] || 0);

    const cumulativeOpexCve = effectiveMonthlyOpexCve * rev.monthsActive;
    const monthlyNetProfitCve = monthlyAverageRevenueCve - effectiveMonthlyOpexCve;
    const netProfitCve = rev.paidCve - installationCostCve - cumulativeOpexCve;
    const monthsToBreakeven = monthlyNetProfitCve > 0 && installationCostCve > 0
      ? installationCostCve / monthlyNetProfitCve
      : null;

    return {
      clientId: c.id,
      clientCode: c.clientCode,
      fullName: c.fullName,
      zone: c.zone,
      island: c.island,
      status: c.status,
      installationCostCve,
      installedEquipmentCostCve,
      installedMaterialsCostCve,
      installLabourCostCve,
      investmentCostCve,
      monthlyDepreciationCve,
      paidRevenueCve: rev.paidCve,
      monthlyAverageRevenueCve,
      effectiveMonthlyOpexCve,
      monthlyNetProfitCve,
      monthlyMarginCve: monthlyNetProfitCve - monthlyDepreciationCve,
      cumulativeOpexCve,
      netProfitCve,
      remainingCapitalCve: Math.max(0, -netProfitCve),
      monthsToBreakeven,
      profitabilityPct: installationCostCve > 0 ? (netProfitCve / installationCostCve) * 100 : null,
      isRecovered: installationCostCve > 0 && netProfitCve >= 0,
      monthsActive: rev.monthsActive
    };
  });
}
