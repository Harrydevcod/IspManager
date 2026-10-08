// src/backend/lib/whatsapp-outbox.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { WhatsappDeliveryStatus, WhatsappProvider, WhatsappSendResult } from './whatsapp-provider';

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
});

// Seed a minimal client + service + payment so FK constraints on
// whatsapp_outbox(doc_payment_id) are satisfied in document-send tests.
let seededPaymentId: number;

beforeEach(() => {
  db.prepare('DELETE FROM whatsapp_outbox').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
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

const okSend = async (): Promise<WhatsappSendResult> => ({ ok: true, messageId: 'mid-1' });
const failSend = async (): Promise<WhatsappSendResult> => ({ ok: false, reason: 'net' });
const renderPdf = async () => ({ buffer: Buffer.from('PDF'), filename: 'fatura.pdf' });

// Um fornecedor falso: o outbox so conhece a interface, nunca o transporte.
function depsWith(overrides: Partial<WhatsappProvider> = {}) {
  const provider: WhatsappProvider = { id: 'ultramsg', label: 'UltraMsg', sendText: okSend, sendDocument: okSend, ...overrides };
  return { resolveProvider: () => provider, renderPdf };
}
const okDeps = depsWith();
const failDeps = depsWith({ sendText: failSend, sendDocument: failSend });
const pollDeps = (statuses: Record<string, WhatsappDeliveryStatus>) =>
  depsWith({ fetchStatuses: async () => new Map(Object.entries(statuses)) });

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string }).status;

describe('enqueueWhatsapp + runWhatsappOutboxIfDue', () => {
  test('enqueue creates a pending row', () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    const row = db.prepare('SELECT status, attempts FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string; attempts: number };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  test('a successful send marks sent and stores the provider message id', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    const result = await outbox.runWhatsappOutboxIfDue(new Date(), okDeps);
    expect(result.sent).toBe(1);
    const row = db.prepare('SELECT status, provider_message_id FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string; provider_message_id: string };
    expect(row.status).toBe('sent');
    expect(row.provider_message_id).toBe('mid-1');
  });

  test('a transient failure schedules a backoff retry, not a terminal failure', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    await outbox.runWhatsappOutboxIfDue(new Date(), failDeps);
    const row = db.prepare('SELECT status, attempts, next_attempt_at, last_error FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string; attempts: number; next_attempt_at: string | null; last_error: string };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
    expect(row.last_error).toBe('net');
  });

  test('does not pick up a row whose next_attempt_at is in the future', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET next_attempt_at = datetime('now','+1 hour') WHERE id = ?`).run(id);
    const result = await outbox.runWhatsappOutboxIfDue(new Date(), okDeps);
    expect(result.sent).toBe(0);
  });

  test('reaching max_attempts marks the row failed', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola', maxAttempts: 1 });
    await outbox.runWhatsappOutboxIfDue(new Date(), failDeps);
    expect(statusOf(id)).toBe('failed');
  });

  test('a document row regenerates the PDF and hands it to the provider', async () => {
    const captured: Array<{ document: Buffer; filename: string; caption: string }> = [];
    const sendDocument: WhatsappProvider['sendDocument'] = async (message) => {
      captured.push(message);
      return { ok: true, messageId: 'doc-1' };
    };
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'document', body: 'A sua fatura', docPaymentId: seededPaymentId, docKind: 'invoice' });
    await outbox.runWhatsappOutboxIfDue(new Date(), depsWith({ sendDocument }));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ filename: 'fatura.pdf', caption: 'A sua fatura' });
    expect(captured[0].document.toString()).toBe('PDF');
    expect(statusOf(id)).toBe('sent');
  });

  test('a second overlapping run is skipped — no double-send', async () => {
    outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'a' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const slowSend = async (): Promise<WhatsappSendResult> => { calls += 1; await gate; return { ok: true, messageId: 'm' }; };
    const deps = depsWith({ sendText: slowSend, sendDocument: slowSend });
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
    await outbox.runWhatsappOutboxIfDue(new Date(), okDeps, { onlyId: a });
    expect(statusOf(a)).toBe('sent');
    expect(statusOf(b)).toBe('pending');
  });

  test('without a configured provider nothing is sent and the row stays pending', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    const result = await outbox.runWhatsappOutboxIfDue(new Date(), { resolveProvider: () => null, renderPdf });
    expect(result).toMatchObject({ skipped: 'UltraMsg nao configurado', sent: 0 });
    expect(statusOf(id)).toBe('pending');
  });

  test('the row is stamped with the provider that actually sent it', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    await outbox.runWhatsappOutboxIfDue(new Date(), depsWith({ id: 'meta-cloud', label: 'Meta Cloud API' }));
    expect((db.prepare('SELECT provider FROM whatsapp_outbox WHERE id = ?').get(id) as { provider: string }).provider).toBe('meta-cloud');
  });
});

describe('pollWhatsappDeliveryIfDue', () => {
  test('advances sent -> delivered -> read by matching provider_message_id', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET status='sent', provider_message_id='mid-9' WHERE id=?`).run(id);

    const r = await outbox.pollWhatsappDeliveryIfDue(new Date(), pollDeps({ 'mid-9': 'delivered' }));
    expect(r.updated).toBe(1);
    expect(statusOf(id)).toBe('delivered');

    await outbox.pollWhatsappDeliveryIfDue(new Date(), pollDeps({ 'mid-9': 'read' }));
    expect(statusOf(id)).toBe('read');
  });

  test('never regresses status (read stays read when the provider reports delivered)', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET status='read', provider_message_id='mid-7' WHERE id=?`).run(id);
    await outbox.pollWhatsappDeliveryIfDue(new Date(), pollDeps({ 'mid-7': 'delivered' }));
    expect(statusOf(id)).toBe('read');
  });

  test('a provider that cannot report deliveries is skipped (Meta: webhook only)', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET status='sent', provider='meta-cloud', provider_message_id='wamid.1' WHERE id=?`).run(id);
    const r = await outbox.pollWhatsappDeliveryIfDue(new Date(), depsWith({ id: 'meta-cloud', label: 'Meta Cloud API' }));
    expect(r.updated).toBe(0);
    expect(r.skipped).toBeDefined();
  });

  test('only rows sent by the active provider are matched', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET status='sent', provider='meta-cloud', provider_message_id='mid-5' WHERE id=?`).run(id);
    const r = await outbox.pollWhatsappDeliveryIfDue(new Date(), pollDeps({ 'mid-5': 'read' }));
    expect(r.updated).toBe(0);
    expect(statusOf(id)).toBe('sent');
  });
});
