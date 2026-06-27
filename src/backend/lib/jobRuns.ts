import type { Database } from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';

export type JobStatus = 'ok' | 'skipped' | 'error';

// ponytail: mantém as últimas 50 execuções por job — histórico suficiente para o
// painel sem precisar de um cron de limpeza; sobe o limite se quiseres mais série.
const KEEP_PER_JOB = 50;

/**
 * Classifica o resultado de um job: um resultado com `skipped` verdadeiro é uma
 * não-execução deliberada (ex.: provider não configurado, já corrido este mês);
 * qualquer outro objeto conta como execução normal.
 */
function classify(result: unknown): JobStatus {
  if (result && typeof result === 'object' && 'skipped' in result && (result as { skipped: unknown }).skipped) {
    return 'skipped';
  }
  return 'ok';
}

export function recordJobRun(job: string, status: JobStatus, durationMs: number, summary: unknown): void {
  const db = getSqliteDatabase();
  db.prepare(`
    INSERT INTO job_runs (job, status, duration_ms, summary_json)
    VALUES (?, ?, ?, ?)
  `).run(job, status, Math.round(durationMs), summary === undefined ? null : JSON.stringify(summary));
  db.prepare(`
    DELETE FROM job_runs
    WHERE job = ? AND id NOT IN (
      SELECT id FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT ?
    )
  `).run(job, job, KEEP_PER_JOB);
}

/** Envolve um job síncrono: cronometra, regista o resultado e re-lança em erro. */
export function runJobSync<T>(job: string, fn: () => T): T {
  const start = Date.now();
  try {
    const result = fn();
    recordJobRun(job, classify(result), Date.now() - start, result);
    return result;
  } catch (err) {
    recordJobRun(job, 'error', Date.now() - start, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Versão assíncrona de {@link runJobSync}. */
export async function runJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordJobRun(job, classify(result), Date.now() - start, result);
    return result;
  } catch (err) {
    recordJobRun(job, 'error', Date.now() - start, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export type JobRunRow = {
  id: number;
  job: string;
  status: JobStatus;
  ranAt: string;
  durationMs: number | null;
  summaryJson: string | null;
};

export type JobHealthRow = JobRunRow & { runs: number; errors: number };

/** Última execução de cada job + contagens na janela retida (para o painel). */
export function jobHealth(db: Database): JobHealthRow[] {
  return db.prepare(`
    SELECT jr.id, jr.job, jr.status, jr.ran_at AS ranAt, jr.duration_ms AS durationMs, jr.summary_json AS summaryJson,
           (SELECT COUNT(*) FROM job_runs x WHERE x.job = jr.job) AS runs,
           (SELECT COUNT(*) FROM job_runs x WHERE x.job = jr.job AND x.status = 'error') AS errors
    FROM job_runs jr
    WHERE jr.id = (SELECT MAX(y.id) FROM job_runs y WHERE y.job = jr.job)
    ORDER BY jr.job
  `).all() as JobHealthRow[];
}

export function recentJobRuns(db: Database, limit = 50): JobRunRow[] {
  return db.prepare(`
    SELECT id, job, status, ran_at AS ranAt, duration_ms AS durationMs, summary_json AS summaryJson
    FROM job_runs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as JobRunRow[];
}
