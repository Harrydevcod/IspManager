import { randomUUID } from 'node:crypto';
import { getSqliteDatabase } from '../db/database';
import { createSmsSignature } from './sms-signing';
import type { SmsEventType } from '../../shared/sms';

export type SmsOutboxStatus = 'pending_dispatch' | 'pending_approval' | 'approved' | 'sent' | 'failed' | 'rejected' | 'cancelled';
export type SmsDispatchResult = { ok: true; androidRequestId: string } | { ok: false; error: string };
export type SmsStatusResult = { status: SmsOutboxStatus; error?: string };

export type SmsOutboxDeps = {
  postRequest: (entry: { id: number; requestId: string; toPhone: string; body: string; eventType: SmsEventType | 'test'; clientName: string | null }) => Promise<SmsDispatchResult>;
  fetchStatus: (androidRequestId: string) => Promise<SmsStatusResult>;
};

export type EnqueueSmsInput = {
  clientId?: number | null;
  paymentId?: number | null;
  serviceId?: number | null;
  eventType: SmsEventType | 'test';
  toPhone: string;
  body: string;
};

function getSetting(key: string): string {
  const row = getSqliteDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || '';
}

function backoffMinutes(attempt: number) {
  return [1, 5, 15, 60, 180][attempt - 1] ?? 360;
}

export function enqueueSmsNotification(input: EnqueueSmsInput): number {
  const info = getSqliteDatabase().prepare(`
    INSERT INTO sms_outbox (client_id, payment_id, service_id, event_type, to_phone, body)
    VALUES (@clientId, @paymentId, @serviceId, @eventType, @toPhone, @body)
  `).run({
    clientId: input.clientId ?? null,
    paymentId: input.paymentId ?? null,
    serviceId: input.serviceId ?? null,
    eventType: input.eventType,
    toPhone: input.toPhone,
    body: input.body
  });
  return info.lastInsertRowid as number;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { error: text };
  }
}

async function signedFetch(path: string, method: 'GET' | 'POST', bodyObject?: unknown): Promise<Response> {
  const baseUrl = getSetting('smsCompanionBaseUrl');
  const secret = getSetting('smsCompanionPairingKey');
  if (!baseUrl || !secret) throw new Error('Companion SMS nao pareado');
  const body = bodyObject ? JSON.stringify(bodyObject) : '';
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const signature = createSmsSignature({ secret, method, path, timestamp, nonce, body });
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-ispm-timestamp': timestamp,
      'x-ispm-nonce': nonce,
      'x-ispm-signature': signature
    },
    body: method === 'POST' ? body : undefined
  });
}

async function defaultPostRequest(entry: { requestId: string; toPhone: string; body: string; eventType: SmsEventType | 'test'; clientName: string | null }): Promise<SmsDispatchResult> {
  try {
    const response = await signedFetch('/requests', 'POST', entry);
    const json = await readJson(response);
    if (!response.ok) return { ok: false, error: String(json.error || `Android recusou SMS (${response.status})`) };
    return { ok: true, androidRequestId: String(json.id || entry.requestId) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Android companion offline' };
  }
}

async function defaultFetchStatus(androidRequestId: string): Promise<SmsStatusResult> {
  try {
    const response = await signedFetch(`/requests/${encodeURIComponent(androidRequestId)}`, 'GET');
    const json = await readJson(response);
    if (!response.ok) return { status: 'failed', error: String(json.error || `Android status falhou (${response.status})`) };
    return {
      status: String(json.status || 'pending_approval') as SmsOutboxStatus,
      error: typeof json.error === 'string' ? json.error : undefined
    };
  } catch (err) {
    return { status: 'pending_approval', error: err instanceof Error ? err.message : 'Android companion offline' };
  }
}

const defaultDeps: SmsOutboxDeps = { postRequest: defaultPostRequest, fetchStatus: defaultFetchStatus };

export async function runSmsOutboxIfDue(
  now: Date = new Date(),
  deps: SmsOutboxDeps = defaultDeps
): Promise<{ dispatched: number; retried: number; skipped?: string }> {
  if (getSetting('smsCompanionEnabled') !== 'true') {
    return { dispatched: 0, retried: 0, skipped: 'SMS companion desativado' };
  }

  const db = getSqliteDatabase();
  const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(`
    SELECT s.id, s.event_type AS eventType, s.to_phone AS toPhone, s.body, s.attempts, s.max_attempts AS maxAttempts, c.full_name AS clientName
    FROM sms_outbox s
    LEFT JOIN clients c ON c.id = s.client_id
    WHERE s.status='pending_dispatch' AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?)
    ORDER BY s.id ASC LIMIT 20
  `).all(nowIso) as Array<{
    id: number;
    eventType: SmsEventType | 'test';
    toPhone: string;
    body: string;
    attempts: number;
    maxAttempts: number;
    clientName: string | null;
  }>;

  let dispatched = 0;
  let retried = 0;

  for (const row of rows) {
    const requestId = randomUUID();
    const result = await deps.postRequest({ id: row.id, requestId, toPhone: row.toPhone, body: row.body, eventType: row.eventType, clientName: row.clientName });
    if (result.ok) {
      db.prepare(`
        UPDATE sms_outbox
        SET status='pending_approval', android_request_id=?, last_error=NULL, next_attempt_at=NULL, updated_at=datetime('now')
        WHERE id=?
      `).run(result.androidRequestId, row.id);
      dispatched += 1;
      continue;
    }

    const attemptsAfter = row.attempts + 1;
    if (attemptsAfter >= row.maxAttempts) {
      db.prepare(`
        UPDATE sms_outbox SET status='failed', attempts=attempts+1, last_error=?, failed_at=datetime('now'), updated_at=datetime('now') WHERE id=?
      `).run(result.error, row.id);
    } else {
      const next = new Date(now.getTime() + backoffMinutes(attemptsAfter) * 60_000).toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`
        UPDATE sms_outbox SET attempts=attempts+1, last_error=?, next_attempt_at=?, updated_at=datetime('now') WHERE id=?
      `).run(result.error, next, row.id);
    }
    retried += 1;
  }

  return { dispatched, retried };
}

export async function pollSmsStatusIfDue(
  _now: Date = new Date(),
  deps: SmsOutboxDeps = defaultDeps
): Promise<{ updated: number }> {
  const db = getSqliteDatabase();
  const rows = db.prepare(`
    SELECT id, android_request_id AS androidRequestId
    FROM sms_outbox
    WHERE status IN ('pending_approval','approved') AND android_request_id IS NOT NULL
  `).all() as Array<{ id: number; androidRequestId: string }>;

  let updated = 0;
  for (const row of rows) {
    const result = await deps.fetchStatus(row.androidRequestId);
    if (!['approved', 'sent', 'failed', 'rejected'].includes(result.status)) continue;

    const column = result.status === 'sent'
      ? 'sent_at'
      : result.status === 'rejected'
        ? 'rejected_at'
        : result.status === 'approved'
          ? 'approved_at'
          : null;

    if (column) {
      db.prepare(`
        UPDATE sms_outbox SET status=?, ${column}=datetime('now'), last_error=?, updated_at=datetime('now') WHERE id=?
      `).run(result.status, result.error ?? null, row.id);
    } else if (result.status === 'failed') {
      db.prepare(`
        UPDATE sms_outbox SET status='failed', failed_at=datetime('now'), last_error=?, updated_at=datetime('now') WHERE id=?
      `).run(result.error ?? null, row.id);
    } else {
      db.prepare(`
        UPDATE sms_outbox SET status=?, last_error=?, updated_at=datetime('now') WHERE id=?
      `).run(result.status, result.error ?? null, row.id);
    }
    updated += 1;
  }

  return { updated };
}
