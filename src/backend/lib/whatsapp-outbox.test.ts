// src/backend/lib/whatsapp-outbox.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { UltraMsgMessage, UltraMsgSendResult } from './ultramsg';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let outbox: typeof import('./whatsapp-outbox');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-wa-outbox-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  outbox = await import('./whatsapp-outbox');
  // UltraMsg must be configured for the worker not to skip.
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
});

// Seed a minimal client + service + payment so FK constraints on
// whatsapp_outbox(doc_payment_id) are satisfied in document-send tests.
let seededPaymentId: number;

beforeEach(() => {
  db.prepare('DELETE FROM whatsapp_outbox').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  const clientId = db.prepare(
    `INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C001','Test Client','+2389900000','active')`
  ).run().lastInsertRowid as number;
  const serviceId = db.prepare(
    `INSERT INTO services (client_id, monthly_value_cve, ip_address, status) VALUES (?, 2000, '10.0.0.1', 'active')`
  ).run(clientId).lastInsertRowid as number;
  seededPaymentId = db.prepare(
    `INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-01', 2000, '2026-01-10', 'paid')`
  ).run(clientId, serviceId).lastInsertRowid as number;
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

const okSend = async (): Promise<UltraMsgSendResult> => ({ ok: true, result: {}, messageId: 'mid-1' });
const failSend = async (): Promise<UltraMsgSendResult> => ({ ok: false, reason: 'net' });
const renderPdf = async () => ({ buffer: Buffer.from('PDF'), filename: 'fatura.pdf' });

describe('enqueueWhatsapp + runWhatsappOutboxIfDue', () => {
  test('enqueue creates a pending row', () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    const row = db.prepare('SELECT status, attempts FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string; attempts: number };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  test('a successful send marks sent and stores the provider message id', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    const result = await outbox.runWhatsappOutboxIfDue(new Date(), { sendText: okSend, sendDocument: okSend, renderPdf });
    expect(result.sent).toBe(1);
    const row = db.prepare('SELECT status, provider_message_id FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string; provider_message_id: string };
    expect(row.status).toBe('sent');
    expect(row.provider_message_id).toBe('mid-1');
  });

  test('a transient failure schedules a backoff retry, not a terminal failure', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    await outbox.runWhatsappOutboxIfDue(new Date(), { sendText: failSend, sendDocument: failSend, renderPdf });
    const row = db.prepare('SELECT status, attempts, next_attempt_at, last_error FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string; attempts: number; next_attempt_at: string | null; last_error: string };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
    expect(row.last_error).toBe('net');
  });

  test('does not pick up a row whose next_attempt_at is in the future', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET next_attempt_at = datetime('now','+1 hour') WHERE id = ?`).run(id);
    const result = await outbox.runWhatsappOutboxIfDue(new Date(), { sendText: okSend, sendDocument: okSend, renderPdf });
    expect(result.sent).toBe(0);
  });

  test('reaching max_attempts marks the row failed', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola', maxAttempts: 1 });
    await outbox.runWhatsappOutboxIfDue(new Date(), { sendText: failSend, sendDocument: failSend, renderPdf });
    const row = db.prepare('SELECT status FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('failed');
  });

  test('a document row regenerates the PDF and sends it as base64', async () => {
    let capturedBase64 = '';
    const sendDocument = async (_i: string, _t: string, _to: string, base64: string): Promise<UltraMsgSendResult> => {
      capturedBase64 = base64; return { ok: true, result: {}, messageId: 'doc-1' };
    };
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'document', body: 'A sua fatura', docPaymentId: seededPaymentId, docKind: 'invoice' });
    await outbox.runWhatsappOutboxIfDue(new Date(), { sendText: okSend, sendDocument, renderPdf });
    expect(capturedBase64).toBe(Buffer.from('PDF').toString('base64'));
    const row = db.prepare('SELECT status FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('sent');
  });

  test('a second overlapping run is skipped — no double-send', async () => {
    outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'a' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const slowSend = async (): Promise<UltraMsgSendResult> => { calls += 1; await gate; return { ok: true, result: {}, messageId: 'm' }; };
    const deps = { sendText: slowSend, sendDocument: slowSend, renderPdf };
    const inFlight = outbox.runWhatsappOutboxIfDue(new Date(), deps);
    const second = await outbox.runWhatsappOutboxIfDue(new Date(), deps); // overlaps the first
    expect(second.skipped).toBeDefined();
    release();
    await inFlight;
    expect(calls).toBe(1);
  });

  test('processes only the requested id when onlyId is given', async () => {
    const a = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'a' });
    const b = outbox.enqueueWhatsapp({ toPhone: '+2389912234', kind: 'text', body: 'b' });
    await outbox.runWhatsappOutboxIfDue(new Date(), { sendText: okSend, sendDocument: okSend, renderPdf }, { onlyId: a });
    const rows = db.prepare('SELECT id, status FROM whatsapp_outbox ORDER BY id').all() as Array<{ id: number; status: string }>;
    expect(rows.find((r) => r.id === a)?.status).toBe('sent');
    expect(rows.find((r) => r.id === b)?.status).toBe('pending');
  });
});

describe('pollWhatsappDeliveryIfDue', () => {
  test('advances sent -> delivered -> read by matching provider_message_id', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET status='sent', provider_message_id='mid-9' WHERE id=?`).run(id);

    const fetchSent = async (): Promise<UltraMsgMessage[]> => [{ id: 'mid-9', ack: 'device' }];
    const r = await outbox.pollWhatsappDeliveryIfDue(new Date(), { fetchSent });
    expect(r.updated).toBe(1);
    expect((db.prepare('SELECT status FROM whatsapp_outbox WHERE id=?').get(id) as { status: string }).status).toBe('delivered');

    const fetchRead = async (): Promise<UltraMsgMessage[]> => [{ id: 'mid-9', ack: 'read' }];
    await outbox.pollWhatsappDeliveryIfDue(new Date(), { fetchSent: fetchRead });
    expect((db.prepare('SELECT status FROM whatsapp_outbox WHERE id=?').get(id) as { status: string }).status).toBe('read');
  });

  test('never regresses status (read stays read when ack reports delivered)', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET status='read', provider_message_id='mid-7' WHERE id=?`).run(id);
    const fetchSent = async (): Promise<UltraMsgMessage[]> => [{ id: 'mid-7', ack: 'device' }];
    await outbox.pollWhatsappDeliveryIfDue(new Date(), { fetchSent });
    expect((db.prepare('SELECT status FROM whatsapp_outbox WHERE id=?').get(id) as { status: string }).status).toBe('read');
  });
});
