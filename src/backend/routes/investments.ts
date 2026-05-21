import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
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
  unitCostCve: z.coerce.number().min(0)
});

const investmentSchema = z.object({
  name: z.string().trim().min(1).max(180),
  type: investmentType.default('outro'),
  clientId: z.coerce.number().int().positive().optional().nullable(),
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

type InvestmentBaseRow = {
  id: number;
  totalCostCve: number;
  expectedMonthlyRevenueCve: number;
  monthlyOperationalCostCve: number;
  accumulatedRevenueCve: number;
  targetClients: number;
  installedClients: number;
  desiredPaybackMonths: number;
  desiredMarginPct: number;
};

type CompanyOpexContext = {
  totalExpensesCve: number;
  monthsWithExpenses: number;
  avgMonthlyOpex: number;
  totalInstalledActive: number;
  opexPerClientPerMonth: number;
};

const ACTIVE_INVESTMENT_STATUSES = new Set(['ativo', 'em_execucao', 'recuperado']);

function loadCompanyOpexContext(
  db: ReturnType<typeof getSqliteDatabase>,
  rows: Array<{ installedClients: number; status: string }>
): CompanyOpexContext {
  const expensesRow = db.prepare(`
    SELECT
      COALESCE(SUM(amount_cve), 0) AS totalExpensesCve,
      COUNT(DISTINCT reference_month) AS monthsWithExpenses
    FROM expenses
  `).get() as { totalExpensesCve: number; monthsWithExpenses: number };

  const totalExpensesCve = Number(expensesRow.totalExpensesCve) || 0;
  const monthsWithExpenses = Math.max(1, Number(expensesRow.monthsWithExpenses) || 0);
  const avgMonthlyOpex = totalExpensesCve / monthsWithExpenses;
  const totalInstalledActive = rows
    .filter((r) => ACTIVE_INVESTMENT_STATUSES.has(r.status))
    .reduce((sum, r) => sum + (Number(r.installedClients) || 0), 0);
  const opexPerClientPerMonth = totalInstalledActive > 0 ? avgMonthlyOpex / totalInstalledActive : 0;

  return { totalExpensesCve, monthsWithExpenses, avgMonthlyOpex, totalInstalledActive, opexPerClientPerMonth };
}

function profitability(row: InvestmentBaseRow, opexCtx: CompanyOpexContext) {
  const activeClients = Math.max(1, row.installedClients || row.targetClients || 1);
  const targetClients = Math.max(1, row.targetClients || 1);
  const imputedMonthlyOpexCve = opexCtx.opexPerClientPerMonth * (Number(row.installedClients) || 0);
  const effectiveMonthlyOpexCve = (Number(row.monthlyOperationalCostCve) || 0) + imputedMonthlyOpexCve;
  const monthlyNetProfitCve = row.expectedMonthlyRevenueCve - effectiveMonthlyOpexCve;
  const costPerClientCve = row.totalCostCve / targetClients;
  const operationalCostPerClientCve = effectiveMonthlyOpexCve / activeClients;
  const baseRecoveryPrice = costPerClientCve / Math.max(1, row.desiredPaybackMonths || 1);
  const recommendedPlanCve = (baseRecoveryPrice + operationalCostPerClientCve)
    * (1 + Math.max(0, row.desiredMarginPct || 0) / 100);
  const accumulatedProfitCve = row.accumulatedRevenueCve - row.totalCostCve;
  return {
    costPerClientCve,
    operationalCostPerClientCve,
    recommendedPlanCve,
    imputedMonthlyOpexCve,
    effectiveMonthlyOpexCve,
    monthlyNetProfitCve,
    accumulatedProfitCve,
    recoveryMonths: monthlyNetProfitCve > 0 ? row.totalCostCve / monthlyNetProfitCve : null,
    roiPct: row.totalCostCve > 0 ? (accumulatedProfitCve / row.totalCostCve) * 100 : null,
    annualRoiPct: row.totalCostCve > 0 ? (((monthlyNetProfitCve * 12) - row.totalCostCve) / row.totalCostCve) * 100 : null,
    isRecovered: accumulatedProfitCve >= 0
  };
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
    `).all(params) as Array<InvestmentBaseRow & { zone: string | null; status: string }>;

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
        total_cost_cve AS totalCostCve
      FROM investment_items
      WHERE investment_id = ?
      ORDER BY id ASC
    `);

    // Company-wide OPEX context (Fase 1 rateio): each active investment absorbs
    // a per-client share of the average monthly OPEX from the expenses table.
    // Use ALL investments matching the activity filter — not only the filtered
    // page — so the denominator reflects company-wide installed base.
    const allActive = db.prepare(`
      SELECT installed_clients AS installedClients, status FROM investments
    `).all() as Array<{ installedClients: number; status: string }>;
    const opexCtx = loadCompanyOpexContext(db, allActive);

    const rowsWithItems = rows.map((row) => ({
      ...row,
      ...profitability(row, opexCtx),
      items: items.all(row.id)
    }));

    const totalCostCve = rowsWithItems.reduce((sum, row) => sum + Number(row.totalCostCve || 0), 0);
    const monthlyNetProfitCve = rowsWithItems.reduce((sum, row) => sum + row.monthlyNetProfitCve, 0);
    const accumulatedProfitCve = rowsWithItems.reduce((sum, row) => sum + row.accumulatedProfitCve, 0);
    const totalImputedOpexCve = rowsWithItems.reduce((sum, row) => sum + row.imputedMonthlyOpexCve, 0);
    const totalEffectiveOpexCve = rowsWithItems.reduce((sum, row) => sum + row.effectiveMonthlyOpexCve, 0);
    const roiRows = rowsWithItems.filter((row) => row.roiPct !== null) as Array<{ roiPct: number }>;
    const lowRoiCount = rowsWithItems.filter((row) => (row.roiPct ?? 0) < 0 || row.monthlyNetProfitCve <= 0).length;
    const notRecoveredCount = rowsWithItems.filter((row) => !row.isRecovered).length;
    const zoneSummary = [...rowsWithItems.reduce((map, row) => {
      const zone = row.zone || 'Sem zona';
      const current = map.get(zone) || { zone, investments: 0, totalCostCve: 0, monthlyNetProfitCve: 0, roiPct: null as number | null };
      current.investments += 1;
      current.totalCostCve += row.totalCostCve;
      current.monthlyNetProfitCve += row.monthlyNetProfitCve;
      current.roiPct = current.totalCostCve > 0
        ? ((current.monthlyNetProfitCve * 12 - current.totalCostCve) / current.totalCostCve) * 100
        : null;
      map.set(zone, current);
      return map;
    }, new Map<string, { zone: string; investments: number; totalCostCve: number; monthlyNetProfitCve: number; roiPct: number | null }>()).values()]
      .sort((a, b) => b.monthlyNetProfitCve - a.monthlyNetProfitCve)
      .slice(0, 6);

    return {
      rows: rowsWithItems,
      totals: {
        count: rowsWithItems.length,
        totalCostCve,
        monthlyNetProfitCve,
        accumulatedProfitCve,
        totalImputedOpexCve,
        totalEffectiveOpexCve,
        averageRoiPct: roiRows.length > 0 ? roiRows.reduce((sum, row) => sum + row.roiPct, 0) / roiRows.length : null,
        lowRoiCount,
        notRecoveredCount
      },
      companyOpexShare: opexCtx,
      zoneSummary,
      alerts: [
        ...(lowRoiCount > 0 ? [`${lowRoiCount} investimento(s) com ROI baixo ou lucro mensal negativo`] : []),
        ...(notRecoveredCount > 0 ? [`${notRecoveredCount} investimento(s) ainda nao recuperados`] : []),
        ...(opexCtx.totalExpensesCve > 0 && opexCtx.totalInstalledActive === 0
          ? ['Despesas registadas sem clientes instalados ativos — rateio OPEX desactivado']
          : [])
      ]
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
        INSERT INTO investment_items (investment_id, item_type, item_name, quantity, quantity_used, unit_cost_cve, total_cost_cve)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(id, item.itemType, item.itemName, item.quantity, item.quantityUsed, item.unitCostCve, item.totalCostCve);
      }
      return id;
    });

    const id = create();
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
        INSERT INTO investment_items (investment_id, item_type, item_name, quantity, quantity_used, unit_cost_cve, total_cost_cve)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(id, item.itemType, item.itemName, item.quantity, item.quantityUsed, item.unitCostCve, item.totalCostCve);
      }
      return true;
    });

    if (!update()) {
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
