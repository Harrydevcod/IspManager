import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { getSqliteDatabase } from '../db/database';
import { createSmsSignature } from './sms-signing';
import type { SmsEventType } from '../../shared/sms';

const DEFAULT_COMPANION_PORT = 8765;

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

function setSetting(key: string, value: string) {
  getSqliteDatabase().prepare(`
    INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, value);
}

// "Reenvio apos falha (minutos)" — flat grace before the next retry, straight
// from settings (validated 1..1440; falls back to 5 if unset/garbage).
function retryGraceMinutes(): number {
  const n = Number(getSetting('smsRetryGraceMinutes'));
  return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : 5;
}

// "Intervalo de envio SMS (segundos)" — how often the outbox is drained.
// Read per tick by the server scheduler so changes apply without a restart.
export function smsDispatchIntervalMs(): number {
  const n = Number(getSetting('smsDispatchIntervalSeconds'));
  const seconds = Number.isFinite(n) && n >= 15 && n <= 3600 ? n : 60;
  return seconds * 1000;
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

async function signedFetch(path: string, method: 'GET' | 'POST', bodyObject?: unknown, timeoutMs?: number, baseUrlOverride?: string): Promise<Response> {
  const baseUrl = baseUrlOverride || getSetting('smsCompanionBaseUrl');
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
    body: method === 'POST' ? body : undefined,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  });
}

/**
 * Probes the paired phone to confirm it actually holds the current pairing
 * secret. The phone's companion server verifies the HMAC signature before
 * routing, so a `401` means the signature was rejected (phone has a different
 * secret or none yet — i.e. it has not scanned this QR), while any other status
 * (200/404) means the signature was accepted → the phone is paired. A network
 * error/timeout means the phone is unreachable (wrong address or off-network).
 */
export async function verifyCompanionPairing(timeoutMs = 3500): Promise<{ reachable: boolean; paired: boolean }> {
  try {
    const response = await signedFetch('/ping', 'GET', undefined, timeoutMs);
    if (response.status === 401) return { reachable: true, paired: false };
    return { reachable: true, paired: true };
  } catch {
    return { reachable: false, paired: false };
  }
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// LAN /24 prefixes of this machine's private IPv4 interfaces (skips loopback,
// APIPA and VPN/public ranges like Radmin so we only sweep the real local net).
function localIpv4Prefixes(): string[] {
  const prefixes = new Set<string>();
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family !== 'IPv4' || net.internal || !isPrivateIpv4(net.address)) continue;
      const [a, b, c] = net.address.split('.');
      prefixes.add(`${a}.${b}.${c}`);
    }
  }
  return [...prefixes];
}

function companionPort(): number {
  const saved = getSetting('smsCompanionBaseUrl');
  if (saved) {
    try { return Number(new URL(saved).port) || DEFAULT_COMPANION_PORT; } catch { /* fall through */ }
  }
  return DEFAULT_COMPANION_PORT;
}

async function respondsAsCompanion(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    // Any HTTP reply (even 401 for a missing/wrong signature) means a companion
    // server is listening here; a network error/timeout means nothing is.
    await fetch(`${baseUrl}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sweeps the local /24(s) for hosts running the companion server on its port.
 * ponytail: /24 + port from the saved address (default 8765), ~700ms probes at
 * 48-wide concurrency. Covers home/office LANs; a /16 or custom port still uses
 * the manual address field.
 */
export async function discoverCompanionHosts(opts?: { timeoutMs?: number; concurrency?: number }): Promise<string[]> {
  const port = companionPort();
  const timeoutMs = opts?.timeoutMs ?? 700;
  const targets: string[] = [];
  for (const prefix of localIpv4Prefixes()) {
    for (let host = 1; host <= 254; host++) targets.push(`http://${prefix}.${host}:${port}`);
  }
  if (targets.length === 0) return [];
  const concurrency = Math.min(opts?.concurrency ?? 48, targets.length);
  const found: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const url = targets[cursor++];
      if (await respondsAsCompanion(url, timeoutMs)) found.push(url);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

/**
 * Among LAN hosts running a companion, the one that accepts our pairing secret
 * (signed `/ping` ≠ 401) is uniquely our paired phone — so this recovers the
 * phone after its DHCP address changes. Pass a precomputed host list to avoid a
 * second sweep. Returns null if none matches (phone off-network / not paired).
 */
export async function findPairedCompanion(hosts?: string[], timeoutMs = 700): Promise<string | null> {
  const secret = getSetting('smsCompanionPairingKey');
  if (!secret) return null;
  const candidates = hosts ?? (await discoverCompanionHosts({ timeoutMs }));
  for (const baseUrl of candidates) {
    try {
      const response = await signedFetch('/ping', 'GET', undefined, timeoutMs, baseUrl);
      if (response.status !== 401) return baseUrl;
    } catch { /* went away mid-sweep — skip */ }
  }
  return null;
}

// Adopts the phone's new address when the saved one stops answering. Only sweeps
// when the companion is actually down, so a healthy setup pays a single /ping.
async function selfHealCompanionAddress(): Promise<void> {
  const current = getSetting('smsCompanionBaseUrl');
  if (!current || !getSetting('smsCompanionPairingKey')) return;
  const { reachable, paired } = await verifyCompanionPairing(1500);
  if (reachable && paired) return;
  const found = await findPairedCompanion();
  if (found && found !== current) setSetting('smsCompanionBaseUrl', found);
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

  // Adopt the phone's new address before dispatching if the saved one went
  // stale. Skipped under test (like the server timers) to avoid a live LAN sweep.
  if (rows.length > 0 && !process.env.VITEST) {
    await selfHealCompanionAddress();
  }

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
      const next = new Date(now.getTime() + retryGraceMinutes() * 60_000).toISOString().replace('T', ' ').slice(0, 19);
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
