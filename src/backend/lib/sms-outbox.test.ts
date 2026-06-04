import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { closeDatabaseForTests, getSqliteDatabase } from '../db/database';
import { enqueueSmsNotification, pollSmsStatusIfDue, runSmsOutboxIfDue } from './sms-outbox';

let dataDir: string;
let db: Database.Database;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-sms-outbox-'));
  process.env.ISPM_DATA_DIR = dataDir;
  db = getSqliteDatabase();
});

beforeEach(() => {
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
  db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionEnabled','true')`).run();
  db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionBaseUrl','http://192.168.1.50:8765')`).run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('SMS outbox', () => {
  test('enqueue creates pending_dispatch row', () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('SMS-1', 'Cliente SMS', 'active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 1000, 10, 'active')`).run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-06', 1000, '2026-06-10', 'pending')`).run(clientId, serviceId).lastInsertRowid as number;
    const id = enqueueSmsNotification({
      eventType: 'test',
      toPhone: '+2389912233',
      body: 'teste',
      clientId,
      paymentId,
      serviceId
    });
    const row = db.prepare('SELECT status, client_id, payment_id, service_id FROM sms_outbox WHERE id = ?').get(id) as {
      status: string;
      client_id: number;
      payment_id: number;
      service_id: number;
    };
    expect(row).toMatchObject({
      status: 'pending_dispatch',
      client_id: clientId,
      payment_id: paymentId,
      service_id: serviceId
    });
  });

  test('dispatch marks pending_approval when Android accepts', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    await runSmsOutboxIfDue(new Date(), {
      postRequest: async () => ({ ok: true, androidRequestId: 'android-1' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });
    const row = db.prepare('SELECT status, android_request_id FROM sms_outbox WHERE id = ?').get(id) as { status: string; android_request_id: string };
    expect(row).toMatchObject({ status: 'pending_approval', android_request_id: 'android-1' });
  });

  test('offline Android schedules retry', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    await runSmsOutboxIfDue(new Date('2026-06-04T12:00:00Z'), {
      postRequest: async () => ({ ok: false, error: 'offline' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });
    const row = db.prepare('SELECT status, attempts, next_attempt_at, last_error FROM sms_outbox WHERE id = ?').get(id) as { status: string; attempts: number; next_attempt_at: string | null; last_error: string };
    expect(row.status).toBe('pending_dispatch');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBeTruthy();
    expect(row.last_error).toBe('offline');
  });

  test('max attempts marks failed with failure timestamp', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare('UPDATE sms_outbox SET max_attempts=1 WHERE id=?').run(id);

    await runSmsOutboxIfDue(new Date('2026-06-04T12:00:00Z'), {
      postRequest: async () => ({ ok: false, error: 'offline' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });

    const row = db.prepare('SELECT status, failed_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; failed_at: string | null };
    expect(row.status).toBe('failed');
    expect(row.failed_at).toBeTruthy();
  });

  test('poll updates final sent status', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id='android-1' WHERE id=?`).run(id);
    await pollSmsStatusIfDue(new Date(), {
      postRequest: async () => ({ ok: true, androidRequestId: 'android-1' }),
      fetchStatus: async () => ({ status: 'sent' })
    });
    const row = db.prepare('SELECT status, sent_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; sent_at: string | null };
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
  });

  test('poll updates final failed status with failure timestamp', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id='android-1' WHERE id=?`).run(id);

    await pollSmsStatusIfDue(new Date(), {
      postRequest: async () => ({ ok: true, androidRequestId: 'android-1' }),
      fetchStatus: async () => ({ status: 'failed', error: 'sem permissao SMS' })
    });

    const row = db.prepare('SELECT status, last_error, failed_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; last_error: string | null; failed_at: string | null };
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('sem permissao SMS');
    expect(row.failed_at).toBeTruthy();
  });
});
