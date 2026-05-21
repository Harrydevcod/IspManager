import type { FastifyInstance } from 'fastify';
import { getSqliteDatabase } from '../db/database';
import { requireAuth } from './auth';

type DashboardMetricRow = {
  totalClients: number;
  activeClients: number;
  suspendedClients: number;
  cancelledClients: number;
  clientsWithoutPhone: number;
  overduePayments: number;
  pendingPayments: number;
  lowStockModels: number;
  activeServices: number;
  openWorkOrders: number;
  paidMonthCve: number;
};

type RevenuePoint = { referenceMonth: string; paidCve: number; pendingCve: number };
type UpcomingDue = { paymentId: number; clientName: string; clientCode: string; dueDate: string; amountCve: number };
type CriticalOverdue = {
  paymentId: number;
  clientName: string;
  clientCode: string;
  clientPhone: string | null;
  dueDate: string;
  amountCve: number;
  daysOverdue: number;
};
type PlanMixEntry = { connectionType: string; count: number };

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function last12Months(): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

export async function registerDashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/summary', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    const currentMonth = currentMonthKey();

    const summary = db.prepare(`
      SELECT
        (SELECT count(*) FROM clients) AS totalClients,
        (SELECT count(*) FROM clients WHERE status = 'active') AS activeClients,
        (SELECT count(*) FROM clients WHERE status = 'suspended') AS suspendedClients,
        (SELECT count(*) FROM clients WHERE status = 'cancelled') AS cancelledClients,
        (SELECT count(*) FROM clients WHERE phone IS NULL OR phone = '') AS clientsWithoutPhone,
        (SELECT count(*) FROM payments WHERE status = 'overdue') AS overduePayments,
        (SELECT count(*) FROM payments WHERE status = 'pending') AS pendingPayments,
        (SELECT count(*) FROM equipment_catalog WHERE active = 1 AND stock_total <= 3) AS lowStockModels,
        (SELECT count(*) FROM services WHERE status = 'active') AS activeServices,
        (SELECT count(*) FROM work_orders WHERE status NOT IN ('concluida','cancelada')) AS openWorkOrders,
        COALESCE((
          SELECT SUM(amount_cve) FROM payments
          WHERE status = 'paid' AND reference_month = @currentMonth
        ), 0) AS paidMonthCve
    `).get({ currentMonth }) as DashboardMetricRow;

    const months = last12Months();
    const revenueRows = db.prepare(`
      SELECT reference_month AS referenceMonth,
             COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cve ELSE 0 END), 0) AS paidCve,
             COALESCE(SUM(CASE WHEN status IN ('pending','overdue') THEN amount_cve ELSE 0 END), 0) AS pendingCve
      FROM payments
      WHERE reference_month >= @from
      GROUP BY reference_month
      ORDER BY reference_month ASC
    `).all({ from: months[0] }) as RevenuePoint[];
    const revenueByMonth: RevenuePoint[] = months.map((month) => {
      const found = revenueRows.find((row) => row.referenceMonth === month);
      return found
        ? { referenceMonth: month, paidCve: Number(found.paidCve) || 0, pendingCve: Number(found.pendingCve) || 0 }
        : { referenceMonth: month, paidCve: 0, pendingCve: 0 };
    });

    const upcomingDues = db.prepare(`
      SELECT payments.id AS paymentId,
             clients.full_name AS clientName,
             clients.client_code AS clientCode,
             payments.due_date AS dueDate,
             payments.amount_cve AS amountCve
      FROM payments
      JOIN clients ON clients.id = payments.client_id
      WHERE payments.status = 'pending'
        AND payments.due_date >= date('now')
        AND payments.due_date < date('now', '+7 days')
      ORDER BY payments.due_date ASC
      LIMIT 6
    `).all() as UpcomingDue[];

    const criticalOverdue = db.prepare(`
      SELECT payments.id AS paymentId,
             clients.full_name AS clientName,
             clients.client_code AS clientCode,
             clients.phone AS clientPhone,
             payments.due_date AS dueDate,
             payments.amount_cve AS amountCve,
             CAST(julianday('now') - julianday(payments.due_date) AS INTEGER) AS daysOverdue
      FROM payments
      JOIN clients ON clients.id = payments.client_id
      WHERE (payments.status = 'overdue'
             OR (payments.status = 'pending' AND payments.due_date < date('now')))
        AND julianday('now') - julianday(payments.due_date) >= 30
      ORDER BY payments.due_date ASC
      LIMIT 5
    `).all() as CriticalOverdue[];

    const planMix = db.prepare(`
      SELECT internet_plans.connection_type AS connectionType,
             count(services.id) AS count
      FROM services
      LEFT JOIN internet_plans ON internet_plans.id = services.plan_id
      WHERE services.status = 'active' AND internet_plans.connection_type IS NOT NULL
      GROUP BY internet_plans.connection_type
      ORDER BY count DESC
    `).all() as PlanMixEntry[];

    const workQueue: string[] = [];
    if (summary.overduePayments > 0) {
      workQueue.push(`${summary.overduePayments} cobrancas em atraso para contactar`);
    }
    if (summary.pendingPayments > 0) {
      workQueue.push(`${summary.pendingPayments} cobrancas pendentes para acompanhar`);
    }
    if (summary.lowStockModels > 0) {
      workQueue.push(`${summary.lowStockModels} modelos com stock baixo`);
    }
    if (summary.clientsWithoutPhone > 0) {
      workQueue.push(`${summary.clientsWithoutPhone} clientes sem telefone no cadastro`);
    }
    if (summary.openWorkOrders > 0) {
      workQueue.push(`${summary.openWorkOrders} OS tecnicas em aberto`);
    }

    return {
      totalClients: summary.totalClients ?? 0,
      activeClients: summary.activeClients ?? 0,
      suspendedClients: summary.suspendedClients ?? 0,
      cancelledClients: summary.cancelledClients ?? 0,
      clientsWithoutPhone: summary.clientsWithoutPhone ?? 0,
      overduePayments: summary.overduePayments ?? 0,
      pendingPayments: summary.pendingPayments ?? 0,
      lowStockModels: summary.lowStockModels ?? 0,
      activeServices: summary.activeServices ?? 0,
      openWorkOrders: summary.openWorkOrders ?? 0,
      paidMonthCve: Number(summary.paidMonthCve) || 0,
      revenueByMonth,
      upcomingDues,
      criticalOverdue,
      planMix,
      workQueue
    };
  });
}
