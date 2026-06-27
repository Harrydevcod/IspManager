import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSqliteDatabase, closeDatabase } from '../db/database';
import { jobHealth, recentJobRuns, recordJobRun, runJob, runJobSync } from './jobRuns';

let dir: string;

function freshDb(): Database.Database {
  closeDatabase();
  dir = mkdtempSync(path.join(tmpdir(), 'ispm-jobs-'));
  process.env.ISPM_DATA_DIR = dir;
  return getSqliteDatabase();
}

afterEach(() => {
  closeDatabase();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('runJobSync', () => {
  test('records ok with the result summary and a duration', () => {
    const db = freshDb();
    const result = runJobSync('auto_billing', () => ({ ran: true, created: 3 }));
    expect(result).toEqual({ ran: true, created: 3 });

    const row = db.prepare('SELECT * FROM job_runs WHERE job = ?').get('auto_billing') as {
      status: string; duration_ms: number; summary_json: string;
    };
    expect(row.status).toBe('ok');
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(row.summary_json)).toEqual({ ran: true, created: 3 });
  });

  test('classifies a result with truthy skipped as skipped', () => {
    const db = freshDb();
    runJobSync('auto_billing', () => ({ skipped: true, reason: 'ja corrido' }));
    const row = db.prepare("SELECT status FROM job_runs WHERE job = 'auto_billing'").get() as { status: string };
    expect(row.status).toBe('skipped');
  });

  test('records error and rethrows when the job throws', () => {
    const db = freshDb();
    expect(() => runJobSync('auto_billing', () => { throw new Error('boom'); })).toThrow('boom');
    const row = db.prepare("SELECT status, summary_json FROM job_runs WHERE job = 'auto_billing'").get() as {
      status: string; summary_json: string;
    };
    expect(row.status).toBe('error');
    expect(JSON.parse(row.summary_json)).toEqual({ error: 'boom' });
  });
});

describe('runJob (async)', () => {
  test('records ok for a resolved promise', async () => {
    const db = freshDb();
    await runJob('whatsapp_drain', async () => ({ sent: 2, failed: 0, retried: 0 }));
    const row = db.prepare("SELECT status FROM job_runs WHERE job = 'whatsapp_drain'").get() as { status: string };
    expect(row.status).toBe('ok');
  });

  test('records error and rejects when the promise rejects', async () => {
    const db = freshDb();
    await expect(runJob('whatsapp_drain', async () => { throw new Error('net'); })).rejects.toThrow('net');
    const row = db.prepare("SELECT status FROM job_runs WHERE job = 'whatsapp_drain'").get() as { status: string };
    expect(row.status).toBe('error');
  });
});

describe('retention + health', () => {
  test('keeps only the last 50 runs per job', () => {
    const db = freshDb();
    for (let i = 0; i < 60; i += 1) recordJobRun('sms_drain', 'ok', 1, { i });
    const count = db.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE job = 'sms_drain'").get() as { n: number };
    expect(count.n).toBe(50);
  });

  test('jobHealth returns the latest run per job with run/error counts', () => {
    const db = freshDb();
    recordJobRun('sms_drain', 'ok', 1, null);
    recordJobRun('sms_drain', 'error', 1, { error: 'x' });
    recordJobRun('sms_drain', 'ok', 1, null);
    recordJobRun('whatsapp_poll', 'skipped', 1, { skipped: 'off' });

    const health = jobHealth(db);
    expect(health).toHaveLength(2);
    const sms = health.find((h) => h.job === 'sms_drain')!;
    expect(sms.status).toBe('ok'); // a mais recente
    expect(sms.runs).toBe(3);
    expect(sms.errors).toBe(1);

    expect(recentJobRuns(db, 10)).toHaveLength(4);
  });
});
