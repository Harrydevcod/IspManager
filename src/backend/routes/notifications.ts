import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsSeen,
  unseenNotificationCount
} from '../lib/notifications';
import { loadDashboardSummary } from '../lib/dashboard-summary';
import { loadOperationsStatus } from '../lib/operations-status';
import { targetForFinding, type OperationsFinding, type OperationsStatus } from '../../shared/operations-status';
import { requireAuth } from './auth';

/**
 * O sino: o que precisa de atenção agora e o que já aconteceu.
 *
 * "Agora" é derivado — não se guarda nada: são os achados vermelhos e âmbar da
 * operação mais os contadores do painel. "Anteriores" é a tabela `notifications`,
 * com o lido de cada utilizador.
 */

export type NotificationNowItem = {
  id: string;
  severity: 'danger' | 'warn' | 'info';
  title: string;
  detail: string | null;
  section: string;
  focus: string | null;
};

/**
 * O relatório da operação é uma série de consultas pesadas; o sino pergunta de
 * minuto a minuto e vários ecrãs podem estar abertos. 30 s de memória chegam
 * para o custo cair sem que o alerta envelheça.
 */
const OPERATIONS_CACHE_MS = 30_000;
let cached: { at: number; status: OperationsStatus } | null = null;

function operationsStatusCached(db: Database, now = Date.now()): OperationsStatus {
  if (cached && now - cached.at < OPERATIONS_CACHE_MS) return cached.status;
  const status = loadOperationsStatus(db);
  cached = { at: now, status };
  return status;
}

export function resetNotificationsCacheForTests() {
  cached = null;
}

function findingsOf(status: OperationsStatus): OperationsFinding[] {
  return [
    ...status.network.findings,
    ...status.customers.findings,
    ...status.fleet.findings,
    ...status.accessLayer.findings,
    ...status.billing.findings,
    ...status.messaging.findings,
    ...status.system.findings,
    ...status.compliance.findings
  ];
}

/** O que precisa de atenção agora, para este papel. */
export function buildNotificationNow(db: Database, role: string | null): NotificationNowItem[] {
  const items: NotificationNowItem[] = [];

  // O técnico não vê o relatório da operação; os contadores do painel vê.
  if (role === 'admin' || role === 'operator') {
    for (const finding of findingsOf(operationsStatusCached(db))) {
      if (finding.severity === 'green') continue;
      const target = targetForFinding(finding.code);
      items.push({
        id: finding.code,
        severity: finding.severity === 'red' ? 'danger' : 'warn',
        title: finding.title,
        detail: finding.detail,
        section: target.section,
        focus: target.focus ?? null
      });
    }
  }

  const summary = loadDashboardSummary(db);
  const counters: Array<[number, NotificationNowItem]> = [
    [summary.overduePayments, { id: 'counter.overdue', severity: 'danger', title: `${summary.overduePayments} pagamento${plural(summary.overduePayments)} em atraso`, detail: null, section: 'finance', focus: 'overdue' }],
    [summary.openTickets, { id: 'counter.tickets', severity: 'warn', title: `${summary.openTickets} pedido${plural(summary.openTickets)} de assistência em aberto`, detail: null, section: 'support', focus: null }],
    [summary.openWorkOrders, { id: 'counter.work-orders', severity: 'info', title: `${summary.openWorkOrders} OS técnica${plural(summary.openWorkOrders)} em aberto`, detail: null, section: 'work-orders', focus: null }],
    [summary.lowStockModels, { id: 'counter.stock', severity: 'info', title: `${summary.lowStockModels} modelo${plural(summary.lowStockModels)} com stock baixo`, detail: null, section: 'stock', focus: null }]
  ];
  for (const [count, item] of counters) if (count > 0) items.push(item);

  const order = { danger: 0, warn: 1, info: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications', { preHandler: requireAuth() }, async (request) => {
    const db = getSqliteDatabase();
    const userId = request.user?.id ?? null;
    return {
      now: buildNotificationNow(db, request.user?.role ?? null),
      history: listNotifications(db, userId),
      unseen: unseenNotificationCount(db, userId)
    };
  });

  app.post('/api/notifications/seen', { preHandler: requireAuth() }, async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Sessão necessária' });
    markNotificationsSeen(getSqliteDatabase(), userId);
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { preHandler: requireAuth() }, async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Sessão necessária' });
    return { marked: markAllNotificationsRead(getSqliteDatabase(), userId) };
  });

  app.post('/api/notifications/:id/read', { preHandler: requireAuth() }, async (request, reply) => {
    const userId = request.user?.id;
    const id = Number((request.params as { id: string }).id);
    if (!userId) return reply.status(401).send({ error: 'Sessão necessária' });
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Notificação inválida' });
    markNotificationRead(getSqliteDatabase(), userId, id);
    return { ok: true };
  });
}
