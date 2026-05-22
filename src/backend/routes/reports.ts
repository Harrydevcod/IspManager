import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';

type ReportMetricRow = {
  totalClients: number;
  activeServices: number;
  overduePayments: number;
  overdueAmountCve: number;
  paidAmountCve: number;
  stockValueCve: number;
};

const querySchema = z.object({
  view: z.enum(['revenue', 'overdue', 'stock']).default('revenue'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function registerReportRoutes(app: FastifyInstance) {
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
      ? `WHERE py.status = 'overdue' AND ${paymentWhere.map((condition) => `py.${condition}`).join(' AND ')}`
      : "WHERE py.status = 'overdue'";

    const db = getSqliteDatabase();

    const metrics = db.prepare(`
      SELECT
        (SELECT count(*) FROM clients) AS totalClients,
        (SELECT count(*) FROM services WHERE status = 'active') AS activeServices,
        (SELECT count(*) FROM payments WHERE status = 'overdue') AS overduePayments,
        (SELECT coalesce(sum(amount_cve), 0) FROM payments WHERE status = 'overdue') AS overdueAmountCve,
        (SELECT coalesce(sum(amount_cve), 0) FROM payments WHERE status = 'paid') AS paidAmountCve,
        (
          SELECT coalesce(sum(stock_total * (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve)), 0)
          FROM equipment_catalog
          WHERE active = 1
        ) AS stockValueCve
    `).get() as ReportMetricRow;

    const revenueByMonth = db.prepare(`
      SELECT
        reference_month AS referenceMonth,
        coalesce(sum(case when status = 'paid' then amount_cve else 0 end), 0) AS paidCve,
        coalesce(sum(case when status = 'pending' then amount_cve else 0 end), 0) AS pendingCve,
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
        coalesce(sum(py.amount_cve), 0) AS amountCve,
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
}
