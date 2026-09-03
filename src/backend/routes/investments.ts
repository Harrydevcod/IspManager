import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { ACTIVE_INVESTMENT_STATUSES, loadCompanyOpexContext, loadRevenueAttribution, monthsSpanInclusive, profitability, type CompanyOpexContext, type InvestmentBaseRow, type RevenueAttribution } from '../lib/opex';
import { buildProfitabilityPdf, buildProfitabilityXlsx } from '../lib/profitability-export';
import { cashReceiptFilterSql } from '../lib/payments';
import { externalInvestmentCapexCve, externalInvestmentCapexSql, parkValue, stockCapexByYear, stockCapexCve } from '../lib/capex';
import { requireAuth, requireRole } from './auth';

const investmentType = z.enum(['cliente', 'zona', 'equipamento', 'infraestrutura', 'manutencao', 'expansao', 'outro']);
const investmentStatus = z.enum(['planeado', 'em_execucao', 'ativo', 'recuperado', 'cancelado']);
const investmentItemType = z.enum([
  'antena',
  'router',
  'cpe',
  'switch',
  'cabo',
  'conector',
  'fibra',
  'caixa',
  'poste',
  'ups',
  'bateria',
  'ferramenta',
  'material',
  'instalacao',
  'mao_obra',
  'manutencao',
  'outro'
]);

const investmentItemSchema = z.object({
  itemType: investmentItemType.default('outro'),
  itemName: z.string().trim().min(1).max(160),
  quantity: z.coerce.number().positive(),
  quantityUsed: z.coerce.number().min(0).default(0),
  unitCostCve: z.coerce.number().min(0),
  // Ligado ao catalogo, o item deixa de somar capital e passa a reclama-lo: o
  // equipamento ja contou quando deu entrada no armazem. Nulo = custo externo.
  catalogId: z.coerce.number().int().positive().optional().nullable()
});

const investmentSchema = z.object({
  name: z.string().trim().min(1).max(180),
  type: investmentType.default('outro'),
  clientId: z.coerce.number().int().positive().optional().nullable(),
  // Associação exata a vários clientes (antena de transmissão que serve um
  // conjunto específico). Complementa clientId legado e zona.
  clientIds: z.array(z.coerce.number().int().positive()).max(500).optional().default([]),
  zone: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  supplier: z.string().trim().max(180).optional().nullable(),
  investmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  referenceMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  status: investmentStatus.default('ativo'),
  targetClients: z.coerce.number().int().positive().default(1),
  installedClients: z.coerce.number().int().min(0).default(0),
  desiredPaybackMonths: z.coerce.number().int().positive().default(6),
  desiredMarginPct: z.coerce.number().min(0).default(30),
  expectedMonthlyRevenueCve: z.coerce.number().min(0).default(0),
  monthlyOperationalCostCve: z.coerce.number().min(0).default(0),
  accumulatedRevenueCve: z.coerce.number().min(0).default(0),
  notes: z.string().trim().max(500).optional().nullable(),
  items: z.array(investmentItemSchema).min(1).max(60)
});

const listQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  year: z.string().regex(/^\d{4}$/).optional(),
  type: investmentType.optional(),
  status: investmentStatus.optional(),
  zone: z.string().trim().max(120).optional()
});

type InvestmentInput = z.infer<typeof investmentSchema>;

function deriveReferenceMonth(input: InvestmentInput): string {
  return input.referenceMonth || input.investmentDate.slice(0, 7);
}

function totalCost(input: InvestmentInput): number {
  return input.items.reduce((sum, item) => sum + item.quantity * item.unitCostCve, 0);
}

function normalizeItems(input: InvestmentInput) {
  return input.items.map((item) => ({
    ...item,
    quantityUsed: Math.min(item.quantity, item.quantityUsed),
    totalCostCve: item.quantity * item.unitCostCve
  }));
}

export async function registerInvestmentRoutes(app: FastifyInstance) {
  const canWrite = { preHandler: requireRole(['admin', 'operator']) };
  const canRead = { preHandler: requireAuth() };

  app.get('/api/investments', canRead, async (request) => {
    const filter = listQuerySchema.safeParse(request.query || {});
    if (!filter.success) {
      return { rows: [], totals: { count: 0, totalCostCve: 0, monthlyNetProfitCve: 0, accumulatedProfitCve: 0, averageRoiPct: null } };
    }

    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.data.month) {
      where.push('investments.reference_month = @month');
      params.month = filter.data.month;
    } else if (filter.data.year) {
      where.push('investments.reference_month >= @from AND investments.reference_month <= @to');
      params.from = `${filter.data.year}-01`;
      params.to = `${filter.data.year}-12`;
    }
    if (filter.data.type) {
      where.push('investments.type = @type');
      params.type = filter.data.type;
    }
    if (filter.data.status) {
      where.push('investments.status = @status');
      params.status = filter.data.status;
    }
    if (filter.data.zone) {
      where.push('investments.zone = @zone');
      params.zone = filter.data.zone;
    }

    const db = getSqliteDatabase();
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT
        investments.id,
        investments.name,
        investments.type,
        investments.client_id AS clientId,
        clients.full_name AS clientName,
        investments.zone,
        investments.description,
        investments.supplier,
        investments.investment_date AS investmentDate,
        investments.reference_month AS referenceMonth,
        investments.status,
        investments.target_clients AS targetClients,
        investments.installed_clients AS installedClients,
        investments.desired_payback_months AS desiredPaybackMonths,
        investments.desired_margin_pct AS desiredMarginPct,
        investments.expected_monthly_revenue_cve AS expectedMonthlyRevenueCve,
        investments.monthly_operational_cost_cve AS monthlyOperationalCostCve,
        investments.accumulated_revenue_cve AS accumulatedRevenueCve,
        investments.total_cost_cve AS totalCostCve,
        investments.notes,
        investments.created_at AS createdAt,
        investments.updated_at AS updatedAt
      FROM investments
      LEFT JOIN clients ON clients.id = investments.client_id
      ${whereSql}
      ORDER BY investments.investment_date DESC, investments.id DESC
    `).all(params) as Array<InvestmentBaseRow & { name: string; zone: string | null; status: string }>;

    const items = db.prepare(`
      SELECT
        id,
        investment_id AS investmentId,
        item_type AS itemType,
        item_name AS itemName,
        quantity,
        quantity_used AS quantityUsed,
        quantity - quantity_used AS quantityRemaining,
        unit_cost_cve AS unitCostCve,
        total_cost_cve AS totalCostCve,
        catalog_id AS catalogId
      FROM investment_items
      WHERE investment_id = ?
      ORDER BY id ASC
    `);

    // Company-wide OPEX context (Fase 1 rateio): each active investment absorbs
    // a per-client share of the average monthly OPEX from the expenses table.
    // loadCompanyOpexContext scans ALL investments so the denominator reflects
    // the company-wide installed base, independent of this query's filter.
    const opexCtx = loadCompanyOpexContext();

    // Waterfall de receita por cliente (claims diretos > zona > pool) — fonte
    // única para linhas e global-share, sem dupla contagem.
    const revenueAttr = loadRevenueAttribution(opexCtx);

    // Clientes associados por investimento (junção + legado), com nomes para a UI.
    const junctionNames = getSqliteDatabase().prepare(`
      SELECT ic.investment_id AS investmentId, c.id, c.full_name AS name
      FROM investment_clients ic JOIN clients c ON c.id = ic.client_id
      ORDER BY c.full_name
    `).all() as Array<{ investmentId: number; id: number; name: string }>;
    const clientsByInvestment = new Map<number, Array<{ id: number; name: string }>>();
    for (const r of junctionNames) {
      const list = clientsByInvestment.get(r.investmentId) ?? [];
      list.push({ id: r.id, name: r.name });
      clientsByInvestment.set(r.investmentId, list);
    }

    const rowsWithItems = rows.map((row) => ({
      ...row,
      ...profitability(row, opexCtx, revenueAttr),
      clients: clientsByInvestment.get(row.id) ?? [],
      items: items.all(row.id)
    }));

    const totalCostCve = rowsWithItems.reduce((sum, row) => sum + Number(row.totalCostCve || 0), 0);
    const totalExpensesCve = opexCtx.totalExpensesCve;
    // "Total investido" = equipamento comprado + custo externo dos investimentos.
    //
    // Ambos os numeros vivem em `lib/capex.ts`, que e a unica definicao de
    // capital do sistema. O equipamento conta pelas ENTRADAS de armazem, nao
    // pelo saldo: a conta antiga somava `stock_total` mais as saidas e, sempre
    // que uma unidade regressava — devolucao, transferencia, troca —, contava-a
    // outra vez sem que ninguem a tivesse comprado.
    const stockAcquiredCve = stockCapexCve();

    // Capital de backbone (transmissão): unidades físicas não retiradas × custo
    // landed. Métrica de visibilidade — não soma a totalInvestedCve.
    const backboneStockRow = getSqliteDatabase()
      .prepare(`
        SELECT COALESCE(SUM(
          (ec.purchase_price_cve + ec.shipping_cost_cve + ec.customs_duty_cve + ec.other_costs_cve)
          * bd.units
        ), 0) AS totalCve
        FROM equipment_catalog ec
        JOIN (
          SELECT catalog_id, COUNT(*) AS units
          FROM backbone_devices
          WHERE status <> 'retired'
          GROUP BY catalog_id
        ) bd ON bd.catalog_id = ec.id
      `)
      .get() as { totalCve: number };
    const backboneStockCve = Number(backboneStockRow.totalCve) || 0;
    // So o custo EXTERNO dos investimentos: uma linha ligada ao catalogo ja
    // contou como compra de equipamento, e somar as duas pagava-a duas vezes.
    const allTimeCapexCve = externalInvestmentCapexCve();
    const totalInvestedCve = stockAcquiredCve + allTimeCapexCve;
    const park = parkValue();

    // Caixa livre acumulada = dinheiro recebido (todos os recibos, todo o
    // historico) menos todo o capital aplicado (infraestrutura + stock) menos as
    // despesas (OPEX). Recibos e nao faturas fechadas: o que foi entregue por
    // conta de uma fatura ainda aberta ja e caixa.
    const receivedRow = getSqliteDatabase()
      .prepare(`SELECT COALESCE(SUM(r.amount_cve), 0) AS totalCve
                FROM payment_receipts r WHERE ${cashReceiptFilterSql('r')}`)
      .get() as { totalCve: number };
    const totalReceivedCve = Number(receivedRow.totalCve) || 0;
    const companyAccumulatedProfitCve = totalReceivedCve - totalInvestedCve - totalExpensesCve;
    // O stock entra aqui com a data da compra. Sem ele, o grafico mostrava uma
    // fatia do capital e o cartao mostrava-o todo: dois numeros com o mesmo nome.
    const byYearRows = getSqliteDatabase().prepare(`
      SELECT year, SUM(capexCve) AS capexCve, SUM(opexCve) AS opexCve
      FROM (
        SELECT substr(i.reference_month, 1, 4) AS year,
               COALESCE(SUM(${externalInvestmentCapexSql('i')}), 0) AS capexCve,
               0 AS opexCve
        FROM investments i
        GROUP BY year
        UNION ALL
        SELECT substr(reference_month, 1, 4) AS year,
               0 AS capexCve,
               COALESCE(SUM(amount_cve), 0) AS opexCve
        FROM expenses
        GROUP BY year
      )
      GROUP BY year
      ORDER BY year DESC
    `).all() as Array<{ year: string; capexCve: number; opexCve: number }>;
    const stockByYear = new Map(stockCapexByYear().map((r) => [r.year, r.capexCve]));
    const yearBuckets = new Map<string, { capexCve: number; opexCve: number }>();
    for (const row of byYearRows) {
      yearBuckets.set(row.year, {
        capexCve: Number(row.capexCve) || 0,
        opexCve: Number(row.opexCve) || 0
      });
    }
    for (const [year, capexCve] of stockByYear) {
      const bucket = yearBuckets.get(year) ?? { capexCve: 0, opexCve: 0 };
      bucket.capexCve += capexCve;
      yearBuckets.set(year, bucket);
    }
    const investedByYear = [...yearBuckets.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([year, bucket]) => ({
        year,
        capexCve: bucket.capexCve,
        opexCve: bucket.opexCve,
        totalCve: bucket.capexCve + bucket.opexCve
      }));
    const monthlyNetProfitCve = rowsWithItems.reduce((sum, row) => sum + row.monthlyNetProfitCve, 0);
    const accumulatedProfitCve = rowsWithItems.reduce((sum, row) => sum + row.accumulatedProfitCve, 0);
    const totalImputedOpexCve = rowsWithItems.reduce((sum, row) => sum + row.imputedMonthlyOpexCve, 0);
    const totalDirectOpexCve = rowsWithItems.reduce((sum, row) => sum + row.directAllocatedOpexCve, 0);
    const totalEffectiveOpexCve = rowsWithItems.reduce((sum, row) => sum + row.effectiveMonthlyOpexCve, 0);
    const totalActualRevenueCve = rowsWithItems.reduce(
      (sum, row) => sum + (row.actualMonthlyRevenueCve ?? 0), 0);
    // Média de ROI ponderada pelo capital — um investimento de 1.000$00 com
    // ROI 300% deixa de pesar o mesmo que um de 500.000$00.
    const roiRows = rowsWithItems.filter((row) => row.roiPct !== null && row.totalCostCve > 0) as Array<{ roiPct: number; totalCostCve: number }>;
    const roiCapital = roiRows.reduce((sum, row) => sum + row.totalCostCve, 0);
    const lowRoiCount = rowsWithItems.filter((row) => (row.roiPct ?? 0) < 0 || row.monthlyNetProfitCve <= 0).length;
    const notRecoveredCount = rowsWithItems.filter((row) => !row.isRecovered).length;
    // Zonas mais rentaveis: agrupa CLIENTES, nao investimentos.
    //
    // A conta antiga somava o lucro dos investimentos pela zona escrita na
    // ficha do investimento. Essa etiqueta nao diz onde vivem os clientes que
    // ele serve — uma antena etiquetada "Cruz" servia clientes de catorze
    // zonas — e os investimentos sem zona caiam todos num balde "Sem zona" que
    // levava nove em doze. Nao eram zonas a competir: era o total da empresa
    // repartido por uma etiqueta.
    //
    // Aqui a zona e a do cliente: receita = recibos de caixa dos clientes da
    // zona; OPEX = rateio por servico ativo + despesas fixadas a zona. Nao
    // segue os filtros da lista (mes/tipo/estado) porque nao le investimentos.
    const zoneLabelSql = `COALESCE(NULLIF(TRIM(c.zone), ''), 'Sem zona')`;
    const receiptSpan = getSqliteDatabase()
      .prepare(`SELECT MIN(substr(r.payment_date, 1, 7)) AS firstMonth,
                       MAX(substr(r.payment_date, 1, 7)) AS lastMonth
                FROM payment_receipts r WHERE ${cashReceiptFilterSql('r')}`)
      .get() as { firstMonth: string | null; lastMonth: string | null };
    // Um unico denominador para todas as zonas: por span proprio, a zona com um
    // so mes de recibos parecia render o dobro da que cobra ha um ano.
    const receiptMonths = monthsSpanInclusive(receiptSpan.firstMonth, receiptSpan.lastMonth);
    const zoneBuckets = new Map<string, { zone: string; clients: number; monthlyRevenueCve: number; monthlyOpexCve: number; monthlyNetProfitCve: number }>();
    const zoneBucket = (zone: string) => {
      const cur = zoneBuckets.get(zone)
        ?? { zone, clients: 0, monthlyRevenueCve: 0, monthlyOpexCve: 0, monthlyNetProfitCve: 0 };
      zoneBuckets.set(zone, cur);
      return cur;
    };
    for (const r of getSqliteDatabase().prepare(`
      SELECT ${zoneLabelSql} AS zone, COALESCE(SUM(r.amount_cve), 0) AS totalCve
      FROM payment_receipts r
      JOIN payments py ON py.id = r.payment_id
      JOIN clients c ON c.id = py.client_id
      WHERE ${cashReceiptFilterSql('r')}
      GROUP BY zone
    `).all() as Array<{ zone: string; totalCve: number }>) {
      zoneBucket(r.zone).monthlyRevenueCve = (Number(r.totalCve) || 0) / receiptMonths;
    }
    for (const r of getSqliteDatabase().prepare(`
      SELECT ${zoneLabelSql} AS zone, COUNT(*) AS n
      FROM services s
      JOIN clients c ON c.id = s.client_id
      WHERE s.status = 'active'
      GROUP BY zone
    `).all() as Array<{ zone: string; n: number }>) {
      const bucket = zoneBucket(r.zone);
      bucket.clients = Number(r.n) || 0;
      bucket.monthlyOpexCve += opexCtx.opexPerClientPerMonth * bucket.clients;
    }
    // Despesas fixadas a uma zona entram inteiras nessa zona (ja estao fora do
    // rateio). A grafia tem de bater com a do cliente — sao a mesma chave.
    for (const [zone, monthly] of Object.entries(opexCtx.directByZone)) {
      zoneBucket(zone).monthlyOpexCve += monthly;
    }
    const zoneSummary = [...zoneBuckets.values()]
      .map((z) => ({ ...z, monthlyNetProfitCve: z.monthlyRevenueCve - z.monthlyOpexCve }))
      .sort((a, b) => b.monthlyNetProfitCve - a.monthlyNetProfitCve)
      .slice(0, 6);

    type Alert = {
      severity: 'info' | 'warning' | 'danger';
      message: string;
      target?: { kind: 'investment' | 'zone' | 'global'; id?: number; name: string };
    };
    const alerts: Alert[] = [];

    for (const row of rowsWithItems) {
      if (row.monthlyNetProfitCve < 0) {
        alerts.push({
          severity: 'danger',
          message: `Lucro mensal negativo (${Math.round(row.monthlyNetProfitCve)} CVE/mês)`,
          target: { kind: 'investment', id: row.id, name: row.name }
        });
      } else if (
        ACTIVE_INVESTMENT_STATUSES.has(row.status)
        && row.roiPct !== null && row.roiPct < 0 && row.monthlyNetProfitCve === 0
      ) {
        // Estagnado: investimento ATIVO com capital por recuperar e lucro mensal
        // zero (sem receita atribuída nem OPEX). O ramo < 0 já é danger acima;
        // planeados ficam de fora — ainda não era suposto renderem.
        alerts.push({
          severity: 'warning',
          message: `ROI ${row.roiPct.toFixed(1)}% sem lucro mensal`,
          target: { kind: 'investment', id: row.id, name: row.name }
        });
      }
      if (
        !row.isRecovered
        && row.recoveryMonths !== null
        && row.desiredPaybackMonths > 0
        && row.recoveryMonths > row.desiredPaybackMonths * 1.5
      ) {
        alerts.push({
          severity: 'warning',
          message: `Recuperação prevista em ${row.recoveryMonths.toFixed(0)} meses (alvo ${row.desiredPaybackMonths})`,
          target: { kind: 'investment', id: row.id, name: row.name }
        });
      }
      // Estado manual dessincronizado do cálculo real de recuperação.
      if (row.isRecovered && (row.status === 'ativo' || row.status === 'em_execucao')) {
        alerts.push({
          severity: 'info',
          message: 'Capital recuperado — atualiza o estado para "Recuperado"',
          target: { kind: 'investment', id: row.id, name: row.name }
        });
      } else if (!row.isRecovered && row.status === 'recuperado') {
        alerts.push({
          severity: 'warning',
          message: 'Estado "Recuperado" mas os números indicam capital por recuperar',
          target: { kind: 'investment', id: row.id, name: row.name }
        });
      }
    }
    for (const zone of zoneSummary) {
      if (zone.monthlyNetProfitCve < 0) {
        alerts.push({
          severity: 'warning',
          message: `Zona ${zone.zone}: lucro mensal agregado negativo`,
          target: { kind: 'zone', name: zone.zone }
        });
      }
    }
    if (opexCtx.totalExpensesCve > 0 && opexCtx.totalInstalledActive === 0) {
      alerts.push({
        severity: 'info',
        message: 'Despesas registadas sem clientes instalados ativos — rateio OPEX desativado',
        target: { kind: 'global', name: 'OPEX' }
      });
    }

    // Equipment usage analytics — top 5 by total cost across the filter set.
    const equipmentMap = new Map<string, { itemType: string; totalCostCve: number; quantity: number; quantityUsed: number }>();
    for (const row of rowsWithItems) {
      for (const item of row.items as Array<{ itemType: string; totalCostCve: number; quantity: number; quantityUsed: number }>) {
        const cur = equipmentMap.get(item.itemType) || { itemType: item.itemType, totalCostCve: 0, quantity: 0, quantityUsed: 0 };
        cur.totalCostCve += Number(item.totalCostCve || 0);
        cur.quantity += Number(item.quantity || 0);
        cur.quantityUsed += Number(item.quantityUsed || 0);
        equipmentMap.set(item.itemType, cur);
      }
    }
    const equipmentTop = [...equipmentMap.values()]
      .sort((a, b) => b.totalCostCve - a.totalCostCve)
      .slice(0, 5);

    return {
      rows: rowsWithItems,
      totals: {
        count: rowsWithItems.length,
        totalCostCve,
        totalExpensesCve,
        totalInvestedCve,
        backboneStockCve, // stock de equipamento marcado backbone (subconjunto do total)
        ownInfrastructureCve: allTimeCapexCve, // investido na infraestrutura propria (tabela investments), sem stock
        totalReceivedCve,
        companyAccumulatedProfitCve,
        // Parque instalado: responde a "quanto vale o que ja montei", ao lado
        // da caixa, que responde a "quanto dinheiro tenho". Nomes separados de
        // proposito — a caixa continua a abater o capital todo de uma vez.
        parkNetValueCve: park.netValueCve,
        parkMonthlyDepreciationCve: park.monthlyDepreciationCve,
        parkUnits: park.units,
        investedByYear,
        monthlyNetProfitCve,
        accumulatedProfitCve,
        totalImputedOpexCve,
        totalDirectOpexCve,
        totalEffectiveOpexCve,
        totalActualRevenueCve,
        averageRoiPct: roiCapital > 0
          ? roiRows.reduce((sum, row) => sum + row.roiPct * row.totalCostCve, 0) / roiCapital
          : null,
        lowRoiCount,
        notRecoveredCount
      },
      companyOpexShare: opexCtx,
      zoneSummary,
      equipmentTop,
      alerts
    };
  });

  app.get('/api/investments/report.pdf', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const buffer = await buildProfitabilityPdf();
    const filename = `Rentabilidade-${new Date().toISOString().slice(0, 10)}.pdf`;
    const inline = (request.query as { inline?: string } | undefined)?.inline === '1';
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`)
      .send(buffer);
  });

  app.get('/api/investments/report.xlsx', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const buffer = await buildProfitabilityXlsx();
    const filename = `Rentabilidade-${new Date().toISOString().slice(0, 10)}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buffer);
  });

  app.get('/api/investments/:id/timeline', canRead, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Id invalido' });
    }
    const db = getSqliteDatabase();
    const inv = db.prepare(`
      SELECT id, name, client_id AS clientId, zone, investment_date AS investmentDate,
             total_cost_cve AS totalCostCve, desired_payback_months AS desiredPaybackMonths,
             installed_clients AS installedClients
      FROM investments WHERE id = ?
    `).get(id) as
      | { id: number; name: string; clientId: number | null; zone: string | null; investmentDate: string;
          totalCostCve: number; desiredPaybackMonths: number; installedClients: number }
      | undefined;
    if (!inv) return reply.status(404).send({ error: 'Investimento nao encontrado' });

    const opexCtx = loadCompanyOpexContext();
    const installed = Number(inv.installedClients) || 0;

    const startMonth = inv.investmentDate.slice(0, 7);
    const now = new Date();
    const endMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const months: string[] = [];
    {
      const [sy, sm] = startMonth.split('-').map(Number);
      const [ey, em] = endMonth.split('-').map(Number);
      let y = sy; let m = sm;
      while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m += 1;
        if (m > 12) { m = 1; y += 1; }
        if (months.length > 240) break; // hard cap 20 years
      }
    }

    // Revenue by month — o mesmo waterfall da lista: clientes reclamados
    // (client_id ∪ investment_clients, com divisão por sharers) > zona (sem os
    // clientes já reclamados por outros investimentos) > quota do pool.
    const claimedClients = opexCtx.claimsByInvestment[id] ?? [];
    const revenueByMonth = new Map<string, number>();
    if (claimedClients.length > 0) {
      const placeholders = claimedClients.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT py.client_id AS clientId, substr(r.payment_date, 1, 7) AS m,
               COALESCE(SUM(r.amount_cve), 0) AS cve
        FROM payment_receipts r
        JOIN payments py ON py.id = r.payment_id
        WHERE ${cashReceiptFilterSql('r')} AND py.client_id IN (${placeholders})
        GROUP BY py.client_id, m
      `).all(...claimedClients) as Array<{ clientId: number; m: string; cve: number }>;
      for (const r of rows) {
        const share = 1 / Math.max(1, opexCtx.sharersByClient[r.clientId] || 1);
        revenueByMonth.set(r.m, (revenueByMonth.get(r.m) ?? 0) + (Number(r.cve) || 0) * share);
      }
    } else if (inv.zone) {
      const rows = db.prepare(`
        SELECT substr(r.payment_date, 1, 7) AS m, COALESCE(SUM(r.amount_cve), 0) AS cve
        FROM payment_receipts r
        JOIN payments py ON py.id = r.payment_id
        JOIN clients c ON c.id = py.client_id
        WHERE c.zone = ? AND ${cashReceiptFilterSql('r')}
          AND py.client_id NOT IN (
            SELECT client_id FROM investment_clients
            UNION SELECT client_id FROM investments WHERE client_id IS NOT NULL
          )
        GROUP BY m
      `).all(inv.zone) as Array<{ m: string; cve: number }>;
      const zoneSharers = Math.max(1, opexCtx.sharersByZone[inv.zone] || 1);
      for (const r of rows) revenueByMonth.set(r.m, (Number(r.cve) || 0) / zoneSharers);
    } else if (opexCtx.totalInstalledUnlinkedActive > 0 && installed > 0) {
      const share = installed / opexCtx.totalInstalledUnlinkedActive;
      const rows = db.prepare(`
        SELECT substr(r.payment_date, 1, 7) AS m, COALESCE(SUM(r.amount_cve), 0) AS cve
        FROM payment_receipts r
        JOIN payments py ON py.id = r.payment_id
        WHERE ${cashReceiptFilterSql('r')} AND py.client_id NOT IN (
          SELECT id FROM clients
          WHERE id IN (SELECT client_id FROM investments WHERE client_id IS NOT NULL)
             OR id IN (SELECT client_id FROM investment_clients)
             OR zone IN (SELECT zone FROM investments WHERE zone IS NOT NULL)
        )
        GROUP BY m
      `).all() as Array<{ m: string; cve: number }>;
      for (const r of rows) revenueByMonth.set(r.m, (Number(r.cve) || 0) * share);
    }

    // Direct OPEX by month: pinado ao investimento a 100% + fração das
    // despesas pinadas aos clientes reclamados/zona (divididas pelos sharers).
    const directOpexByMonth = new Map<string, number>();
    const addDirect = (rows: Array<{ m: string; cve: number }>, divisor: number) => {
      for (const r of rows) {
        directOpexByMonth.set(r.m, (directOpexByMonth.get(r.m) ?? 0) + (Number(r.cve) || 0) / divisor);
      }
    };
    addDirect(db.prepare(`
      SELECT reference_month AS m, COALESCE(SUM(amount_cve), 0) AS cve
      FROM expenses WHERE investment_id = ? GROUP BY reference_month
    `).all(id) as Array<{ m: string; cve: number }>, 1);
    for (const clientId of claimedClients) {
      addDirect(db.prepare(`
        SELECT reference_month AS m, COALESCE(SUM(amount_cve), 0) AS cve
        FROM expenses WHERE client_id = ? AND investment_id IS NULL GROUP BY reference_month
      `).all(clientId) as Array<{ m: string; cve: number }>, Math.max(1, opexCtx.sharersByClient[clientId] || 1));
    }
    if (inv.zone) {
      addDirect(db.prepare(`
        SELECT reference_month AS m, COALESCE(SUM(amount_cve), 0) AS cve
        FROM expenses WHERE zone = ? AND investment_id IS NULL AND client_id IS NULL GROUP BY reference_month
      `).all(inv.zone) as Array<{ m: string; cve: number }>, Math.max(1, opexCtx.sharersByZone[inv.zone] || 1));
    }

    let cumulativeNet = 0;
    let recoveredAt: string | null = null;
    const points = months.map((month) => {
      const revenue = revenueByMonth.get(month) ?? 0;
      const directOpex = directOpexByMonth.get(month) ?? 0;
      // Imputado das despesas REAIS do mês — não a média de hoje aplicada
      // retroativamente a meses em que o OPEX não existia.
      const imputed = opexCtx.rateioDenominator > 0
        ? ((opexCtx.unallocatedByMonth[month] ?? 0) / opexCtx.rateioDenominator) * installed
        : 0;
      const monthlyNet = revenue - imputed - directOpex;
      cumulativeNet += monthlyNet;
      const cumulativeProfit = cumulativeNet - inv.totalCostCve;
      if (recoveredAt === null && cumulativeProfit >= 0) recoveredAt = month;
      return {
        month,
        paidRevenueCve: revenue,
        imputedOpexCve: imputed,
        directOpexCve: directOpex,
        monthlyNetCve: monthlyNet,
        cumulativeNetCve: cumulativeNet,
        cumulativeProfitCve: cumulativeProfit,
        roiPct: inv.totalCostCve > 0 ? (cumulativeProfit / inv.totalCostCve) * 100 : null
      };
    });

    return {
      investment: { id: inv.id, name: inv.name, totalCostCve: inv.totalCostCve, desiredPaybackMonths: inv.desiredPaybackMonths, investmentDate: inv.investmentDate },
      points,
      recoveredAt,
      monthsToRecovery: recoveredAt ? months.indexOf(recoveredAt) + 1 : null
    };
  });

  app.post('/api/investments', canWrite, async (request, reply) => {
    const parsed = investmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de investimento invalidos' });
    }

    const db = getSqliteDatabase();
    const referenceMonth = deriveReferenceMonth(parsed.data);
    const cost = totalCost(parsed.data);
    const items = normalizeItems(parsed.data);

    const create = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO investments (
          name, type, client_id, zone, description, supplier, investment_date, reference_month,
          status, target_clients, installed_clients, desired_payback_months, desired_margin_pct,
          expected_monthly_revenue_cve, monthly_operational_cost_cve, accumulated_revenue_cve,
          total_cost_cve, notes,
          created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        parsed.data.name,
        parsed.data.type,
        parsed.data.clientId || null,
        parsed.data.zone || null,
        parsed.data.description || null,
        parsed.data.supplier || null,
        parsed.data.investmentDate,
        referenceMonth,
        parsed.data.status,
        parsed.data.targetClients,
        parsed.data.installedClients,
        parsed.data.desiredPaybackMonths,
        parsed.data.desiredMarginPct,
        parsed.data.expectedMonthlyRevenueCve,
        parsed.data.monthlyOperationalCostCve,
        parsed.data.accumulatedRevenueCve,
        cost,
        parsed.data.notes || null,
        request.user?.id ?? null
      );
      const id = Number(result.lastInsertRowid);
      const insertItem = db.prepare(`
        INSERT INTO investment_items (investment_id, item_type, item_name, quantity, quantity_used, unit_cost_cve, total_cost_cve, catalog_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(id, item.itemType, item.itemName, item.quantity, item.quantityUsed, item.unitCostCve, item.totalCostCve, item.catalogId ?? null);
      }
      const insertClient = db.prepare(`INSERT OR IGNORE INTO investment_clients (investment_id, client_id) VALUES (?, ?)`);
      for (const clientId of parsed.data.clientIds) insertClient.run(id, clientId);
      return id;
    });

    let id: number;
    try {
      id = create();
    } catch (err) {
      if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) {
        return reply.status(400).send({ error: 'Cliente associado invalido' });
      }
      throw err;
    }
    recordAudit(request, {
      action: 'create',
      entityType: 'investment',
      entityId: id,
      summary: `Registou investimento ${parsed.data.name}`,
      metadata: { type: parsed.data.type, totalCostCve: cost, referenceMonth }
    });
    return reply.status(201).send({ id });
  });

  app.put('/api/investments/:id', canWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = investmentSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de investimento invalidos' });
    }

    const db = getSqliteDatabase();
    const referenceMonth = deriveReferenceMonth(parsed.data);
    const cost = totalCost(parsed.data);
    const items = normalizeItems(parsed.data);

    const update = db.transaction(() => {
      const result = db.prepare(`
        UPDATE investments
        SET name = ?,
            type = ?,
            client_id = ?,
            zone = ?,
            description = ?,
            supplier = ?,
            investment_date = ?,
            reference_month = ?,
            status = ?,
            target_clients = ?,
            installed_clients = ?,
            desired_payback_months = ?,
            desired_margin_pct = ?,
            expected_monthly_revenue_cve = ?,
            monthly_operational_cost_cve = ?,
            accumulated_revenue_cve = ?,
            total_cost_cve = ?,
            notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        parsed.data.name,
        parsed.data.type,
        parsed.data.clientId || null,
        parsed.data.zone || null,
        parsed.data.description || null,
        parsed.data.supplier || null,
        parsed.data.investmentDate,
        referenceMonth,
        parsed.data.status,
        parsed.data.targetClients,
        parsed.data.installedClients,
        parsed.data.desiredPaybackMonths,
        parsed.data.desiredMarginPct,
        parsed.data.expectedMonthlyRevenueCve,
        parsed.data.monthlyOperationalCostCve,
        parsed.data.accumulatedRevenueCve,
        cost,
        parsed.data.notes || null,
        id
      );
      if (result.changes === 0) return false;

      db.prepare('DELETE FROM investment_items WHERE investment_id = ?').run(id);
      const insertItem = db.prepare(`
        INSERT INTO investment_items (investment_id, item_type, item_name, quantity, quantity_used, unit_cost_cve, total_cost_cve, catalog_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(id, item.itemType, item.itemName, item.quantity, item.quantityUsed, item.unitCostCve, item.totalCostCve, item.catalogId ?? null);
      }
      db.prepare('DELETE FROM investment_clients WHERE investment_id = ?').run(id);
      const insertClient = db.prepare(`INSERT OR IGNORE INTO investment_clients (investment_id, client_id) VALUES (?, ?)`);
      for (const clientId of parsed.data.clientIds) insertClient.run(id, clientId);
      return true;
    });

    let updated: boolean;
    try {
      updated = update();
    } catch (err) {
      if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) {
        return reply.status(400).send({ error: 'Cliente associado invalido' });
      }
      throw err;
    }
    if (!updated) {
      return reply.status(404).send({ error: 'Investimento nao encontrado' });
    }

    recordAudit(request, {
      action: 'update',
      entityType: 'investment',
      entityId: id,
      summary: `Atualizou investimento ${parsed.data.name}`,
      metadata: { type: parsed.data.type, totalCostCve: cost, referenceMonth }
    });
    return { ok: true };
  });

  app.delete('/api/investments/:id', canWrite, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Id invalido' });
    }

    const db = getSqliteDatabase();
    const existing = db.prepare('SELECT name, total_cost_cve AS totalCostCve, reference_month AS referenceMonth FROM investments WHERE id = ?')
      .get(id) as { name: string; totalCostCve: number; referenceMonth: string } | undefined;
    if (!existing) {
      return reply.status(404).send({ error: 'Investimento nao encontrado' });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM investment_items WHERE investment_id = ?').run(id);
      db.prepare('DELETE FROM investments WHERE id = ?').run(id);
    })();

    recordAudit(request, {
      action: 'delete',
      entityType: 'investment',
      entityId: id,
      summary: `Apagou investimento ${existing.name}`,
      metadata: { totalCostCve: existing.totalCostCve, referenceMonth: existing.referenceMonth }
    });
    return { ok: true };
  });
}
