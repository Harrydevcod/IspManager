import type { FastifyInstance } from 'fastify';
import { loadDashboardSummary } from '../lib/dashboard-summary';
import { requireAuth } from './auth';

export async function registerDashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/summary', { preHandler: requireAuth() }, async () => loadDashboardSummary());
}
