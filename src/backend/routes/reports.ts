import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';
import { computeIncompleteFlags, findDuplicateGroups, type DqClient } from '../lib/data-quality';
import { recordAudit } from '../lib/audit';
import { balanceSqlExpr, cashReceiptFilterSql, overdueSqlPredicate } from '../lib/payments';
import { loadOperationsStatus } from '../lib/operations-status';
import { buildOperationsStatusPdf } from '../lib/operations-export';

type ReportMetricRow = {
  totalClients: number;
  activeServices: number;
  overduePayments: number;
  overdueAmountCve: number;
  paidAmountCve: number;
  stockValueCve: number;
};

const dataQualityQuerySchema = z.object({
  issue: z.enum(['noPhone', 'noActiveService', 'noAddress', 'noNif']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

const dismissDuplicateSchema = z.object({
  clientIdA: z.coerce.number().int().positive(),
  clientIdB: z.coerce.number().int().positive()
});

const querySchema = z.object({
  view: z.enum(['revenue', 'overdue', 'stock']).default('revenue'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function registerReportRoutes(app: FastifyInstance) {
  /**
   * Estado da operação — leitura viva, sem cache.
   *
   * O renderer faz polling curto sobre este endpoint. Em SQLite local o custo
   * é de milissegundos e servir dados de há cinco minutos num painel de
   * monitorização mente exatamente quando mais importa acertar.
   */
  app.get('/api/reports/operations', { preHandler: requireRole(['admin', 'operator']) }, async () => {
    return loadOperationsStatus();
  });

  // Fotografia do mesmo read model para arquivo mensal. Sem `attachment` a app
  // empacotada (file://) não consegue ler o nome — ver o cors exposedHeaders.
  app.get('/api/reports/operations.pdf', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const pdf = await buildOperationsStatusPdf();
    const stamp = new Date().toISOString().slice(0, 7);
    const filename = `Estado da operacao - ${stamp}.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(pdf);
  });

  app.get('/api/reports/summary', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Filtros invalidos' });
    }

    const { view, page, pageSize, dateFrom, dateTo } = parsed.data;
    const offset = (page - 1) * pageSize;
    const paymentWhere: string[] = [];
    const params: Record<string, unknown> = { limit: pageSize, offset };
    if (dateFrom) {
      paymentWhere.push('due_date >= @dateFrom');
      params.dateFrom = dateFrom;
    }
    if (dateTo) {
      paymentWhere.push('due_date <= @dateTo');
      params.dateTo = dateTo;
    }
    const paymentWhereSql = paymentWhere.length ? `WHERE ${paymentWhere.join(' AND ')}` : '';
    const overdueWhereSql = paymentWhere.length
      ? `WHERE ${overdueSqlPredicate('py')} AND ${paymentWhere.map((condition) => `py.${condition}`).join(' AND ')}`
      : `WHERE ${overdueSqlPredicate('py')}`;

    const db = getSqliteDatabase();

    const metrics = db.prepare(`
      SELECT
        (SELECT count(*) FROM clients) AS totalClients,
        (SELECT count(*) FROM services WHERE status = 'active') AS activeServices,
        (SELECT count(*) FROM payments WHERE ${overdueSqlPredicate()}) AS overduePayments,
        -- Divida e saldo: quem ja entregou metade so deve a outra metade.
        (SELECT coalesce(sum(${balanceSqlExpr('payments')}), 0) FROM payments WHERE ${overdueSqlPredicate()}) AS overdueAmountCve,
        -- Recebido vem dos recibos, a unica granularidade que ve os parciais.
        (SELECT coalesce(sum(r.amount_cve), 0) FROM payment_receipts r
          WHERE ${cashReceiptFilterSql('r')}) AS paidAmountCve,
        (
          SELECT coalesce(sum(stock_total * (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve)), 0)
          FROM equipment_catalog
          WHERE active = 1
        ) AS stockValueCve
    `).get() as ReportMetricRow;

    const revenueByMonth = db.prepare(`
      SELECT
        reference_month AS referenceMonth,
        coalesce(sum(case when status <> 'cancelled'
          then amount_cve - ${balanceSqlExpr('payments')} else 0 end), 0) AS paidCve,
        coalesce(sum(case when status in ('pending','overdue')
          then ${balanceSqlExpr('payments')} else 0 end), 0) AS pendingCve,
        count(*) AS payments
      FROM payments
      ${paymentWhereSql}
      GROUP BY reference_month
      ORDER BY reference_month DESC
      LIMIT @limit
      OFFSET @offset
    `).all(params);

    const revenueTotal = db.prepare(`
      SELECT count(*) AS total
      FROM (
        SELECT reference_month
        FROM payments
        ${paymentWhereSql}
        GROUP BY reference_month
      )
    `).get(params) as { total: number };

    const overdueClients = db.prepare(`
      SELECT
        c.full_name AS clientName,
        c.client_code AS clientCode,
        c.phone,
        count(py.id) AS payments,
        coalesce(sum(${balanceSqlExpr('py')}), 0) AS amountCve,
        min(py.due_date) AS oldestDueDate
      FROM payments py
      JOIN clients c ON c.id = py.client_id
      ${overdueWhereSql}
      GROUP BY c.id
      ORDER BY amountCve DESC, oldestDueDate
      LIMIT @limit
      OFFSET @offset
    `).all(params);

    const overdueTotal = db.prepare(`
      SELECT count(*) AS total
      FROM (
        SELECT c.id
        FROM payments py
        JOIN clients c ON c.id = py.client_id
        ${overdueWhereSql}
        GROUP BY c.id
      )
    `).get(params) as { total: number };

    const stockRows = db.prepare(`
      SELECT
        type,
        coalesce(brand, '') AS brand,
        model,
        stock_total AS stockTotal,
        (stock_total * (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve)) AS valueCve
      FROM equipment_catalog
      WHERE active = 1
      ORDER BY stock_total ASC, brand, model
      LIMIT @limit
      OFFSET @offset
    `).all(params);

    const stockTotal = db.prepare(`
      SELECT count(*) AS total
      FROM equipment_catalog
      WHERE active = 1
    `).get() as { total: number };

    const total = view === 'revenue'
      ? revenueTotal.total
      : view === 'overdue'
        ? overdueTotal.total
        : stockTotal.total;

    return {
      metrics,
      revenueByMonth,
      overdueClients,
      stockRows,
      pagination: {
        view,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    };
  });

  app.get('/api/reports/data-quality', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const parsed = dataQualityQuerySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Filtros invalidos' });
    }
    const { issue, page, pageSize } = parsed.data;
    const db = getSqliteDatabase();

    const rows = db.prepare(`
      SELECT
        c.id,
        c.client_code AS clientCode,
        c.full_name AS fullName,
        c.phone,
        c.nif,
        c.address,
        c.island,
        c.zone,
        c.status,
        EXISTS(SELECT 1 FROM services s WHERE s.client_id = c.id AND s.status = 'active') AS hasActiveService
      FROM clients c
    `).all() as DqClient[];

    const withFlags = rows.map((row) => ({ row, flags: computeIncompleteFlags(row) }));

    const incompleteCounts = withFlags.reduce(
      (acc, { flags }) => {
        if (flags.includes('noPhone')) acc.noPhone++;
        if (flags.includes('noActiveService')) acc.noActiveService++;
        if (flags.includes('noAddress')) acc.noAddress++;
        if (flags.includes('noNif')) acc.noNif++;
        if (flags.length > 0) acc.total++;
        return acc;
      },
      { noPhone: 0, noActiveService: 0, noAddress: 0, noNif: 0, total: 0 }
    );

    const filtered = withFlags.filter((x) =>
      issue ? x.flags.includes(issue) : x.flags.length > 0
    );
    const total = filtered.length;
    const offset = (page - 1) * pageSize;
    const incompleteClients = filtered.slice(offset, offset + pageSize).map((x) => ({
      id: x.row.id,
      clientCode: x.row.clientCode,
      fullName: x.row.fullName,
      status: x.row.status,
      phone: x.row.phone,
      flags: x.flags
    }));

    const dismissedRows = db.prepare(`
      SELECT client_id_low AS low, client_id_high AS high FROM client_duplicate_dismissals
    `).all() as Array<{ low: number; high: number }>;
    const dismissedPairs = new Set(dismissedRows.map((d) => `${d.low}-${d.high}`));
    const duplicateGroups = findDuplicateGroups(rows, dismissedPairs);

    return {
      incompleteCounts,
      incompleteClients,
      duplicateGroups,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    };
  });

  app.post('/api/reports/data-quality/dismiss', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const parsed = dismissDuplicateSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.clientIdA === parsed.data.clientIdB) {
      return reply.status(400).send({ error: 'Par invalido' });
    }
    const low = Math.min(parsed.data.clientIdA, parsed.data.clientIdB);
    const high = Math.max(parsed.data.clientIdA, parsed.data.clientIdB);
    const db = getSqliteDatabase();
    db.prepare(`
      INSERT OR IGNORE INTO client_duplicate_dismissals (client_id_low, client_id_high)
      VALUES (?, ?)
    `).run(low, high);

    recordAudit(request, {
      action: 'dismiss_duplicate',
      entityType: 'client',
      entityId: low,
      summary: `Marcou os clientes ${low} e ${high} como nao duplicados`,
      metadata: { low, high }
    });

    return reply.send({ ok: true });
  });
}
