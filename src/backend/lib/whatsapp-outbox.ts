// src/backend/lib/whatsapp-outbox.ts
import { getSqliteDatabase } from '../db/database';
import { renderPaymentDocumentPdf } from './documents';
import {
  configuredWhatsappProviderLabel,
  resolveWhatsappProvider,
  type WhatsappProvider,
  type WhatsappSendResult
} from './whatsapp-provider';

export type WhatsappOutboxEntry = {
  toPhone: string;
  kind: 'text' | 'document';
  body?: string | null;
  docPaymentId?: number | null;
  docKind?: 'invoice' | 'receipt' | null;
  clientId?: number | null;
  origin?: 'manual' | 'auto';
  maxAttempts?: number;
};

type PdfRenderer = (paymentId: number, kind: 'invoice' | 'receipt') => Promise<{ buffer: Buffer; filename: string }>;

export type OutboxDeps = {
  /** `null` = fornecedor por configurar: o outbox não contacta ninguém. */
  resolveProvider: () => WhatsappProvider | null;
  renderPdf: PdfRenderer;
};

const defaultDeps: OutboxDeps = {
  resolveProvider: () => resolveWhatsappProvider(getSqliteDatabase()),
  renderPdf: renderPaymentDocumentPdf
};

// Exponential backoff (minutes) per attempt number (1-based).
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
function backoffMinutes(attempt: number): number {
  return BACKOFF_MINUTES[attempt - 1] ?? 360;
}

function notConfigured(): string {
  return `${configuredWhatsappProviderLabel(getSqliteDatabase())} nao configurado`;
}

export function enqueueWhatsapp(entry: WhatsappOutboxEntry): number {
  const db = getSqliteDatabase();
  // A coluna `provider` fica com o valor por omissão: quem a decide é o envio,
  // porque é o fornecedor ativo nesse momento que fica dono da mensagem.
  const info = db.prepare(`
    INSERT INTO whatsapp_outbox (to_phone, kind, body, doc_payment_id, doc_kind, client_id, origin, max_attempts)
    VALUES (@toPhone, @kind, @body, @docPaymentId, @docKind, @clientId, @origin, @maxAttempts)
  `).run({
    toPhone: entry.toPhone,
    kind: entry.kind,
    body: entry.body ?? null,
    docPaymentId: entry.docPaymentId ?? null,
    docKind: entry.docKind ?? null,
    clientId: entry.clientId ?? null,
    origin: entry.origin ?? 'manual',
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
// (e.g. while a slow provider request is in flight) could select and re-send the
// same pending row. One backend process makes a flag sufficient — true
// multi-process safety would need a per-row claim.
let outboxRunning = false;

export async function runWhatsappOutboxIfDue(
  now: Date = new Date(),
  deps: OutboxDeps = defaultDeps,
  opts: { batchSize?: number; onlyId?: number } = {}
): Promise<OutboxRunResult> {
  const provider = deps.resolveProvider();
  if (!provider) {
    return { skipped: notConfigured(), sent: 0, failed: 0, retried: 0 };
  }
  if (outboxRunning) {
    return { skipped: 'drain ja em execucao', sent: 0, failed: 0, retried: 0 };
  }
  outboxRunning = true;
  try {
    return await drainOutbox(now, provider, deps.renderPdf, opts);
  } finally {
    outboxRunning = false;
  }
}

async function drainOutbox(
  now: Date,
  provider: WhatsappProvider,
  renderPdf: PdfRenderer,
  opts: { batchSize?: number; onlyId?: number }
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

  // O `provider_message_id` só faz sentido junto de quem o emitiu.
  const markSent = db.prepare(`UPDATE whatsapp_outbox SET status='sent', provider=?, provider_message_id=?, attempts=attempts+1, last_error=NULL, next_attempt_at=NULL, updated_at=datetime('now') WHERE id=?`);
  const markRetry = db.prepare(`UPDATE whatsapp_outbox SET attempts=attempts+1, last_error=?, next_attempt_at=?, updated_at=datetime('now') WHERE id=?`);
  const markFailed = db.prepare(`UPDATE whatsapp_outbox SET status='failed', attempts=attempts+1, last_error=?, updated_at=datetime('now') WHERE id=?`);

  let sent = 0, failed = 0, retried = 0;

  for (const row of rows) {
    let result: WhatsappSendResult;
    try {
      if (row.kind === 'document') {
        if (!row.doc_payment_id || !row.doc_kind) {
          markFailed.run('Documento sem pagamento/tipo', row.id); failed += 1; continue;
        }
        const { buffer, filename } = await renderPdf(row.doc_payment_id, row.doc_kind);
        result = await provider.sendDocument({ to: row.to_phone, document: buffer, filename, caption: row.body ?? '' });
      } else {
        result = await provider.sendText({ to: row.to_phone, body: row.body ?? '' });
      }
    } catch (err) {
      // Rendering/permanent error — do not retry forever.
      markFailed.run(err instanceof Error ? err.message : 'Erro ao preparar envio', row.id);
      failed += 1;
      continue;
    }

    if (result.ok) {
      markSent.run(provider.id, result.messageId ?? null, row.id);
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

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export async function pollWhatsappDeliveryIfDue(
  _now: Date = new Date(),
  deps: Pick<OutboxDeps, 'resolveProvider'> = defaultDeps
): Promise<{ skipped?: string; updated: number }> {
  const provider = deps.resolveProvider();
  if (!provider) {
    return { skipped: notConfigured(), updated: 0 };
  }
  if (!provider.fetchStatuses) {
    return { skipped: `${provider.label} nao permite consultar entregas`, updated: 0 };
  }
  const db = getSqliteDatabase();
  const pending = db.prepare(`
    SELECT id, provider_message_id AS pid, status FROM whatsapp_outbox
    WHERE status IN ('sent','delivered') AND provider_message_id IS NOT NULL AND provider = ?
  `).all(provider.id) as Array<{ id: number; pid: string; status: string }>;
  if (pending.length === 0) return { updated: 0 };

  const statusById = await provider.fetchStatuses();
  const update = db.prepare(`UPDATE whatsapp_outbox SET status=?, updated_at=datetime('now') WHERE id=?`);

  let updated = 0;
  for (const row of pending) {
    const next = statusById.get(row.pid);
    if (!next) continue;
    if ((STATUS_RANK[next] ?? 0) > (STATUS_RANK[row.status] ?? 0)) {
      update.run(next, row.id);
      updated += 1;
    }
  }
  return { updated };
}
