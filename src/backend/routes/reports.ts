import type { FastifyInstance } from 'fastify';
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

export async function registerReportRoutes(app: FastifyInstance) {
  app.get('/api/reports/summary', { preHandler: requireRole(['admin', 'operator']) }, async () => {
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
      GROUP BY reference_month
      ORDER BY reference_month DESC
      LIMIT 12
    `).all();

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
      WHERE py.status = 'overdue'
      GROUP BY c.id
      ORDER BY amountCve DESC, oldestDueDate
      LIMIT 20
    `).all();

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
      LIMIT 20
    `).all();

    return { metrics, revenueByMonth, overdueClients, stockRows };
  });
}
