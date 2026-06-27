import type { FastifyInstance } from 'fastify';
import { getSqliteDatabase } from '../db/database';
import { jobHealth, recentJobRuns, type JobRunRow } from '../lib/jobRuns';
import { requireRole } from './auth';

function parseSummary(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function withSummary<T extends JobRunRow>(row: T) {
  return { ...row, summary: parseSummary(row.summaryJson), summaryJson: undefined };
}

export async function registerJobRoutes(app: FastifyInstance) {
  // Saúde dos jobs in-process: última execução por job + histórico recente.
  app.get('/api/jobs/health', { preHandler: requireRole(['admin']) }, async () => {
    const db = getSqliteDatabase();
    return {
      jobs: jobHealth(db).map(withSummary),
      recent: recentJobRuns(db, 50).map(withSummary)
    };
  });
}
