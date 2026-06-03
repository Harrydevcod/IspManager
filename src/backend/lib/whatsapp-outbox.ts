// src/backend/lib/whatsapp-outbox.ts
import { getSqliteDatabase } from '../db/database';
import { renderPaymentDocumentPdf } from '../routes/documents';
import { fetchUltraMsgSentMessages, mapAckToStatus, sendDocumentViaUltraMsg, sendViaUltraMsg, type UltraMsgMessage, type UltraMsgSendResult } from './ultramsg';

export type WhatsappOutboxEntry = {
  toPhone: string;
  kind: 'text' | 'document';
  body?: string | null;
  docPaymentId?: number | null;
  docKind?: 'invoice' | 'receipt' | null;
  clientId?: number | null;
  origin?: 'manual' | 'auto';
  provider?: string;
  maxAttempts?: number;
};

type Sender = (instanceId: string, token: string, to: string, body: string) => Promise<UltraMsgSendResult>;
type DocumentSender = (instanceId: string, token: string, to: string, base64: string, filename: string, caption?: string) => Promise<UltraMsgSendResult>;
type PdfRenderer = (paymentId: number, kind: 'invoice' | 'receipt') => Promise<{ buffer: Buffer; filename: string }>;

export type OutboxDeps = {
  sendText: Sender;
  sendDocument: DocumentSender;
  renderPdf: PdfRenderer;
};

const defaultDeps: OutboxDeps = {
  sendText: sendViaUltraMsg,
  sendDocument: sendDocumentViaUltraMsg,
  renderPdf: renderPaymentDocumentPdf
};

// Exponential backoff (minutes) per attempt number (1-based).
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
function backoffMinutes(attempt: number): number {
  return BACKOFF_MINUTES[attempt - 1] ?? 360;
}

function getSetting(key: string): string {
  const row = getSqliteDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value.trim() || '';
}

export function enqueueWhatsapp(entry: WhatsappOutboxEntry): number {
  const db = getSqliteDatabase();
  const info = db.prepare(`
    INSERT INTO whatsapp_outbox (to_phone, kind, body, doc_payment_id, doc_kind, client_id, origin, provider, max_attempts)
    VALUES (@toPhone, @kind, @body, @docPaymentId, @docKind, @clientId, @origin, @provider, @maxAttempts)
  `).run({
    toPhone: entry.toPhone,
    kind: entry.kind,
    body: entry.body ?? null,
    docPaymentId: entry.docPaymentId ?? null,
    docKind: entry.docKind ?? null,
    clientId: entry.clientId ?? null,
    origin: entry.origin ?? 'manual',
    provider: entry.provider ?? 'ultramsg',
    maxAttempts: entry.maxAttempts ?? 5
  });
  return info.lastInsertRowid as number;
}

type OutboxRow = {
  id: number; to_phone: string; kind: 'text' | 'document'; body: string | null;
  doc_payment_id: number | null; doc_kind: 'invoice' | 'receipt' | null;
  attempts: number; max_attempts: number;
};

export type OutboxRunResult = { skipped?: string; sent: number; failed: number; retried: number };

// Single-process re-entrancy guard. The boot scheduler drains on an interval
// and manual sends drain a single row inline; without this, an overlapping tick
// (e.g. while a slow UltraMsg request is in flight) could select and re-send the
// same pending row. One backend process makes a flag sufficient — true
// multi-process safety would need a per-row claim.
let outboxRunning = false;

export async function runWhatsappOutboxIfDue(
  now: Date = new Date(),
  deps: OutboxDeps = defaultDeps,
  opts: { batchSize?: number; onlyId?: number } = {}
): Promise<OutboxRunResult> {
  const instanceId = getSetting('ultraMsgInstanceId');
  const token = getSetting('ultraMsgToken');
  if (!instanceId || !token) {
    return { skipped: 'UltraMsg nao configurado', sent: 0, failed: 0, retried: 0 };
  }
  if (outboxRunning) {
    return { skipped: 'drain ja em execucao', sent: 0, failed: 0, retried: 0 };
  }
  outboxRunning = true;
  try {
    return await drainOutbox(now, deps, opts, instanceId, token);
  } finally {
    outboxRunning = false;
  }
}

async function drainOutbox(
  now: Date,
  deps: OutboxDeps,
  opts: { batchSize?: number; onlyId?: number },
  instanceId: string,
  token: string
): Promise<OutboxRunResult> {
  const db = getSqliteDatabase();
  const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(`
    SELECT id, to_phone, kind, body, doc_payment_id, doc_kind, attempts, max_attempts
    FROM whatsapp_outbox
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= @nowIso)
      ${opts.onlyId ? 'AND id = @onlyId' : ''}
    ORDER BY id ASC
    LIMIT @batchSize
  `).all({ nowIso, batchSize: opts.batchSize ?? 20, onlyId: opts.onlyId ?? 0 }) as OutboxRow[];

  const markSent = db.prepare(`UPDATE whatsapp_outbox SET status='sent', provider_message_id=?, attempts=attempts+1, last_error=NULL, next_attempt_at=NULL, updated_at=datetime('now') WHERE id=?`);
  const markRetry = db.prepare(`UPDATE whatsapp_outbox SET attempts=attempts+1, last_error=?, next_attempt_at=?, updated_at=datetime('now') WHERE id=?`);
  const markFailed = db.prepare(`UPDATE whatsapp_outbox SET status='failed', attempts=attempts+1, last_error=?, updated_at=datetime('now') WHERE id=?`);

  let sent = 0, failed = 0, retried = 0;

  for (const row of rows) {
    let result: UltraMsgSendResult;
    try {
      if (row.kind === 'document') {
        if (!row.doc_payment_id || !row.doc_kind) {
          markFailed.run('Documento sem pagamento/tipo', row.id); failed += 1; continue;
        }
        const { buffer, filename } = await deps.renderPdf(row.doc_payment_id, row.doc_kind);
        result = await deps.sendDocument(instanceId, token, row.to_phone, buffer.toString('base64'), filename, row.body ?? '');
      } else {
        result = await deps.sendText(instanceId, token, row.to_phone, row.body ?? '');
      }
    } catch (err) {
      // Rendering/permanent error — do not retry forever.
      markFailed.run(err instanceof Error ? err.message : 'Erro ao preparar envio', row.id);
      failed += 1;
      continue;
    }

    if (result.ok) {
      markSent.run(result.messageId ?? null, row.id);
      sent += 1;
    } else {
      const attemptsAfter = row.attempts + 1;
      if (attemptsAfter >= row.max_attempts) {
        markFailed.run(result.reason, row.id);
        failed += 1;
      } else {
        const next = new Date(now.getTime() + backoffMinutes(attemptsAfter) * 60_000)
          .toISOString().replace('T', ' ').slice(0, 19);
        markRetry.run(result.reason, next, row.id);
        retried += 1;
      }
    }
  }

  return { sent, failed, retried };
}

export type PollDeps = {
  fetchSent: (instanceId: string, token: string, opts?: { limit?: number; page?: number }) => Promise<UltraMsgMessage[]>;
};
const defaultPollDeps: PollDeps = { fetchSent: fetchUltraMsgSentMessages };

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export async function pollWhatsappDeliveryIfDue(
  _now: Date = new Date(),
  deps: PollDeps = defaultPollDeps
): Promise<{ skipped?: string; updated: number }> {
  const instanceId = getSetting('ultraMsgInstanceId');
  const token = getSetting('ultraMsgToken');
  if (!instanceId || !token) {
    return { skipped: 'UltraMsg nao configurado', updated: 0 };
  }
  const db = getSqliteDatabase();
  const pending = db.prepare(`
    SELECT id, provider_message_id AS pid, status FROM whatsapp_outbox
    WHERE status IN ('sent','delivered') AND provider_message_id IS NOT NULL
  `).all() as Array<{ id: number; pid: string; status: string }>;
  if (pending.length === 0) return { updated: 0 };

  const messages = await deps.fetchSent(instanceId, token, { limit: 100 });
  const ackById = new Map(messages.map((m) => [m.id, mapAckToStatus(m.ack)]));
  const update = db.prepare(`UPDATE whatsapp_outbox SET status=?, updated_at=datetime('now') WHERE id=?`);

  let updated = 0;
  for (const row of pending) {
    const next = ackById.get(row.pid);
    if (!next) continue;
    if ((STATUS_RANK[next] ?? 0) > (STATUS_RANK[row.status] ?? 0)) {
      update.run(next, row.id);
      updated += 1;
    }
  }
  return { updated };
}
