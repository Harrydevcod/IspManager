# WhatsApp Fase 1 (outbox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Robustecer a integração WhatsApp (UltraMsg) com anexo de PDF (fatura/recibo), fila de envio com retries/backoff, e estado de entrega por polling — tudo via uma `whatsapp_outbox` persistente.

**Architecture:** Tabela `whatsapp_outbox` drenada por um worker in-process; transporte UltraMsg estendido (id do envio, documento base64, listagem de enviados) atrás de um `dispatch` injetável; `notices.ts` passa a enfileirar; o gerador de PDF é extraído para reuso.

**Tech Stack:** Fastify 5, better-sqlite3, Zod, Vitest (backend); React 19 (renderer). Windows: `npm.cmd`/`npx.cmd`.

---

## File Structure

- Modify `src/backend/lib/ultramsg.ts` — `messageId` no resultado; `sendDocumentViaUltraMsg`; `fetchUltraMsgSentMessages`; `mapAckToStatus`.
- Create `src/backend/lib/ultramsg.test.ts` — unit (fetch mockado).
- Create `src/backend/db/migrations/0014_whatsapp_outbox.ts` + `0015_whatsapp_notices_outbox_link.ts`; modify `migrations/index.ts`.
- Modify `src/backend/routes/documents.ts` — extrair/exportar `renderPaymentDocumentPdf` + `PaymentDocumentError`; rotas passam a usá-lo.
- Create `src/backend/lib/whatsapp-outbox.ts` — `enqueueWhatsapp`, `runWhatsappOutboxIfDue`, `pollWhatsappDeliveryIfDue`.
- Create `src/backend/lib/whatsapp-outbox.test.ts` — unit (deps injetadas).
- Modify `src/backend/routes/whatsapp.ts` — `/send` enfileira+processa inline; novo `POST /api/payments/:id/whatsapp`.
- Modify `src/backend/routes/whatsapp.test.ts` — cobertura das rotas novas.
- Modify `src/backend/lib/notices.ts` — enfileira em vez de enviar; liga `outbox_id`.
- Modify `src/backend/lib/notices.test.ts` — adapta às novas expectativas.
- Modify `src/backend/server.ts` — agenda worker + poller no boot.
- Modify `src/renderer/modules/PaymentsModule.tsx` — botão "Enviar por WhatsApp".

**Auth/tests:** route/engine tests usam `process.env.ISPM_AUTH='off'` (requireRole no-op) — precedente em `whatsapp.test.ts`. Suite com `--no-file-parallelism`.

---

## Task 1: UltraMsg transport extensions

**Files:**
- Modify: `src/backend/lib/ultramsg.ts`
- Test: `src/backend/lib/ultramsg.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/lib/ultramsg.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchUltraMsgSentMessages, mapAckToStatus, sendDocumentViaUltraMsg, sendViaUltraMsg } from './ultramsg';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  })));
}

describe('sendViaUltraMsg', () => {
  test('captures the message id from the response', async () => {
    stubFetch(200, { sent: 'true', message: 'ok', id: 'true_123@c.us' });
    const result = await sendViaUltraMsg('instance1', 'tok', '+2389912233', 'ola');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messageId).toBe('true_123@c.us');
  });

  test('fails when the provider rejects', async () => {
    stubFetch(401, { error: 'bad token' });
    const result = await sendViaUltraMsg('instance1', 'tok', '+2389912233', 'ola');
    expect(result.ok).toBe(false);
  });
});

describe('sendDocumentViaUltraMsg', () => {
  test('posts to /messages/document with filename and base64 document', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ sent: 'true', id: 'doc_1' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendDocumentViaUltraMsg('instance1', 'tok', '+2389912233', 'BASE64DATA', 'fatura.pdf', 'A sua fatura');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messageId).toBe('doc_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/messages/document');
    const sentBody = (init as { body: URLSearchParams }).body.toString();
    expect(sentBody).toContain('filename=fatura.pdf');
    expect(sentBody).toContain('document=BASE64DATA');
  });
});

describe('fetchUltraMsgSentMessages', () => {
  test('returns the messages array', async () => {
    stubFetch(200, { messages: [{ id: 'a', ack: 'read' }, { id: 'b', ack: 'device' }] });
    const rows = await fetchUltraMsgSentMessages('instance1', 'tok', { limit: 100 });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('returns [] on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    expect(await fetchUltraMsgSentMessages('instance1', 'tok')).toEqual([]);
  });
});

describe('mapAckToStatus', () => {
  test('maps known acks', () => {
    expect(mapAckToStatus('read')).toBe('read');
    expect(mapAckToStatus('played')).toBe('read');
    expect(mapAckToStatus('device')).toBe('delivered');
    expect(mapAckToStatus('server')).toBe('sent');
    expect(mapAckToStatus(3)).toBe('read');
    expect(mapAckToStatus(2)).toBe('delivered');
    expect(mapAckToStatus(1)).toBe('sent');
    expect(mapAckToStatus('weird')).toBe('sent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/ultramsg.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement**

In `src/backend/lib/ultramsg.ts`, replace the `UltraMsgSendResult` type and `sendViaUltraMsg`, and append the new functions:

```ts
export type UltraMsgSendResult =
  | { ok: true; result: unknown; messageId?: string }
  | { ok: false; reason: string; details?: unknown };

function extractMessageId(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const id = (result as Record<string, unknown>).id;
    if (typeof id === 'string' && id) return id;
    if (typeof id === 'number') return String(id);
  }
  return undefined;
}

async function postUltraMsg(
  instanceId: string,
  endpoint: 'chat' | 'document',
  params: Record<string, string>
): Promise<UltraMsgSendResult> {
  const payload = new URLSearchParams(params);
  try {
    const response = await fetch(`https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload
    });
    const result = await readUltraMsgResponse(response);
    if (!response.ok) {
      return { ok: false, reason: 'UltraMsg recusou o envio', details: result };
    }
    return { ok: true, result, messageId: extractMessageId(result) };
  } catch {
    return { ok: false, reason: 'Nao foi possivel contactar UltraMsg' };
  }
}

export async function sendViaUltraMsg(instanceId: string, token: string, to: string, body: string): Promise<UltraMsgSendResult> {
  return postUltraMsg(instanceId, 'chat', { token, to, body });
}

export async function sendDocumentViaUltraMsg(
  instanceId: string, token: string, to: string, documentBase64: string, filename: string, caption = ''
): Promise<UltraMsgSendResult> {
  return postUltraMsg(instanceId, 'document', { token, to, filename, document: documentBase64, caption });
}

export type UltraMsgMessage = { id: string; ack: string | number };

export async function fetchUltraMsgSentMessages(
  instanceId: string, token: string, opts: { limit?: number; page?: number } = {}
): Promise<UltraMsgMessage[]> {
  const params = new URLSearchParams({
    token, status: 'sent', sort: 'desc',
    page: String(opts.page ?? 1), limit: String(opts.limit ?? 100)
  });
  try {
    const response = await fetch(`https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages?${params.toString()}`);
    const result = await readUltraMsgResponse(response);
    if (!response.ok || !result || typeof result !== 'object') return [];
    const list = (result as Record<string, unknown>).messages;
    if (!Array.isArray(list)) return [];
    return list
      .filter((m): m is { id: unknown; ack: unknown } => !!m && typeof m === 'object')
      .map((m) => ({ id: String((m as Record<string, unknown>).id ?? ''), ack: (m as Record<string, unknown>).ack as string | number }))
      .filter((m) => m.id);
  } catch {
    return [];
  }
}

export function mapAckToStatus(ack: string | number): 'sent' | 'delivered' | 'read' {
  if (typeof ack === 'number') return ack >= 3 ? 'read' : ack === 2 ? 'delivered' : 'sent';
  const v = ack.toLowerCase();
  if (v.includes('read') || v.includes('played') || v.includes('viewed')) return 'read';
  if (v.includes('device') || v.includes('delivered')) return 'delivered';
  return 'sent';
}
```

Keep the existing `normalizeUltraMsgPhone` and `readUltraMsgResponse` functions as-is.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/ultramsg.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/ultramsg.ts src/backend/lib/ultramsg.test.ts
git commit -m "feat(whatsapp): UltraMsg document send, sent-list polling, message id capture"
```

---

## Task 2: Migrations (outbox + notices link)

**Files:**
- Create: `src/backend/db/migrations/0014_whatsapp_outbox.ts`
- Create: `src/backend/db/migrations/0015_whatsapp_notices_outbox_link.ts`
- Modify: `src/backend/db/migrations/index.ts`

- [ ] **Step 1: Create migration 0014**

```ts
// src/backend/db/migrations/0014_whatsapp_outbox.ts
import type { Migration } from './types';

/**
 * Persistent WhatsApp send queue. Every outbound message (manual, automatic
 * notice, or document attachment) becomes a row here; an in-process worker
 * drains it with retry/backoff and a poller advances delivery status. Documents
 * store a reference (payment + kind) and are regenerated at send time.
 */
const migration: Migration = {
  version: 14,
  name: 'whatsapp_outbox',
  sql: `
    CREATE TABLE IF NOT EXISTS whatsapp_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_phone TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('text','document')) DEFAULT 'text',
      body TEXT,
      doc_payment_id INTEGER REFERENCES payments(id),
      doc_kind TEXT CHECK(doc_kind IN ('invoice','receipt')),
      client_id INTEGER REFERENCES clients(id),
      origin TEXT NOT NULL CHECK(origin IN ('manual','auto')) DEFAULT 'manual',
      provider TEXT NOT NULL DEFAULT 'ultramsg',
      provider_message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','sent','delivered','read','failed','cancelled')) DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wa_outbox_ready ON whatsapp_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_wa_outbox_provider_msg ON whatsapp_outbox(provider_message_id);
  `
};

export default migration;
```

- [ ] **Step 2: Create migration 0015**

```ts
// src/backend/db/migrations/0015_whatsapp_notices_outbox_link.ts
import type { Migration } from './types';

/**
 * Link an automatic notice to the outbox row that actually delivers it. ADD
 * COLUMN is safe in SQLite (no table rebuild), unlike a CHECK change.
 */
const migration: Migration = {
  version: 15,
  name: 'whatsapp_notices_outbox_link',
  sql: `
    ALTER TABLE whatsapp_notices ADD COLUMN outbox_id INTEGER REFERENCES whatsapp_outbox(id);
  `
};

export default migration;
```

- [ ] **Step 3: Register both in the index**

In `src/backend/db/migrations/index.ts` add imports after the `m0013` import:

```ts
import m0014 from './0014_whatsapp_outbox';
import m0015 from './0015_whatsapp_notices_outbox_link';
```

And extend the array:

```ts
export const migrations: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015];
```

- [ ] **Step 4: Verify typecheck**

Run: `npm.cmd run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db/migrations/0014_whatsapp_outbox.ts src/backend/db/migrations/0015_whatsapp_notices_outbox_link.ts src/backend/db/migrations/index.ts
git commit -m "feat(whatsapp): migrations for outbox queue + notices link"
```

---

## Task 3: Extract `renderPaymentDocumentPdf`

**Files:**
- Modify: `src/backend/routes/documents.ts`

- [ ] **Step 1: Add the exported helper + error class**

In `src/backend/routes/documents.ts`, immediately after the `pdfBuffer` function (around line 540), add:

```ts
export class PaymentDocumentError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'PaymentDocumentError';
  }
}

/**
 * Single source of truth for a payment's invoice/receipt PDF: validates the
 * payment, enforces the same guards as the HTTP routes, assigns the document
 * number if missing, and returns the rendered buffer + filename. Used by the
 * HTTP routes and the WhatsApp outbox worker. Throws PaymentDocumentError with
 * the HTTP status the routes should surface.
 */
export async function renderPaymentDocumentPdf(id: number, kind: DocumentKind): Promise<{ buffer: Buffer; filename: string }> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new PaymentDocumentError(400, 'Pagamento invalido');
  }
  const db = getSqliteDatabase();
  let row = db.prepare(documentSelect).get(id) as PaymentDocumentRow | undefined;
  if (!row) {
    throw new PaymentDocumentError(404, 'Pagamento nao encontrado');
  }
  if (row.status === 'cancelled') {
    throw new PaymentDocumentError(400, kind === 'invoice' ? 'Pagamento anulado nao pode gerar fatura' : 'Pagamento anulado nao pode gerar recibo');
  }
  if (kind === 'receipt' && row.status !== 'paid') {
    throw new PaymentDocumentError(400, 'So e possivel gerar recibo depois do pagamento');
  }
  if (kind === 'invoice' && !hasDocumentNumber(row.invoiceNumber)) {
    db.prepare(`
      UPDATE payments
      SET invoice_number = ?, invoice_date = COALESCE(invoice_date, date('now')), updated_at = datetime('now')
      WHERE id = ?
    `).run(nextDocumentNumber('invoice', id), id);
    row = db.prepare(documentSelect).get(id) as PaymentDocumentRow;
  }
  if (kind === 'receipt' && !row.receiptNumber) {
    db.prepare(`
      UPDATE payments
      SET receipt_number = ?, receipt_date = COALESCE(receipt_date, date('now')), updated_at = datetime('now')
      WHERE id = ?
    `).run(nextDocumentNumber('receipt', id), id);
    row = db.prepare(documentSelect).get(id) as PaymentDocumentRow;
  }
  const buffer = await pdfBuffer(row, kind);
  return { buffer, filename: documentFilename(kind, row) };
}
```

- [ ] **Step 2: Refactor the two routes to use it**

Replace the body of `app.get('/api/payments/:id/invoice.pdf', ...)` with:

```ts
  app.get('/api/payments/:id/invoice.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const { buffer, filename } = await renderPaymentDocumentPdf(id, 'invoice');
      const disposition = dispositionFromQuery(request.query);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="${filenamePart(filename, 'documento.pdf')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer);
    } catch (err) {
      if (err instanceof PaymentDocumentError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
```

Replace the body of `app.get('/api/payments/:id/receipt.pdf', ...)` with the same shape but `'receipt'`:

```ts
  app.get('/api/payments/:id/receipt.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const { buffer, filename } = await renderPaymentDocumentPdf(id, 'receipt');
      const disposition = dispositionFromQuery(request.query);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="${filenamePart(filename, 'documento.pdf')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer);
    } catch (err) {
      if (err instanceof PaymentDocumentError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
```

(The old `sendDocument` helper may now be unused — if TypeScript/lint flags it as unused, delete it.)

- [ ] **Step 3: Run the documents tests (safety net)**

Run: `npx.cmd vitest run src/backend/routes/documents.test.ts`
Expected: PASS (behavior unchanged — same 400/404/cancelled/paid-guard/numbering/buffer).

- [ ] **Step 4: Typecheck + commit**

```bash
npm.cmd run typecheck
git add src/backend/routes/documents.ts
git commit -m "refactor(documents): extract renderPaymentDocumentPdf for reuse by routes + outbox"
```

---

## Task 4: Outbox engine — enqueue + worker

**Files:**
- Create: `src/backend/lib/whatsapp-outbox.ts`
- Test: `src/backend/lib/whatsapp-outbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/lib/whatsapp-outbox.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { UltraMsgSendResult } from './ultramsg';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let outbox: typeof import('./whatsapp-outbox');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-wa-outbox-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('./db/database').catch(() => import('../db/database'));
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  outbox = await import('./whatsapp-outbox');
  // UltraMsg must be configured for the worker not to skip.
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
});

beforeEach(() => {
  db.prepare('DELETE FROM whatsapp_outbox').run();
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
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'document', body: 'A sua fatura', docPaymentId: 1, docKind: 'invoice' });
    await outbox.runWhatsappOutboxIfDue(new Date(), { sendText: okSend, sendDocument, renderPdf });
    expect(capturedBase64).toBe(Buffer.from('PDF').toString('base64'));
    const row = db.prepare('SELECT status FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('sent');
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
```

> Note: the dynamic `import('./db/database')` fallback handles the test running from the `lib` dir; the engine itself imports `../db/database` normally.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/whatsapp-outbox.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement enqueue + worker**

```ts
// src/backend/lib/whatsapp-outbox.ts
import { getSqliteDatabase } from '../db/database';
import { renderPaymentDocumentPdf } from '../routes/documents';
import { sendDocumentViaUltraMsg, sendViaUltraMsg, type UltraMsgSendResult } from './ultramsg';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/whatsapp-outbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/whatsapp-outbox.ts src/backend/lib/whatsapp-outbox.test.ts
git commit -m "feat(whatsapp): outbox enqueue + worker with retry/backoff and PDF attach"
```

---

## Task 5: Delivery status poller

**Files:**
- Modify: `src/backend/lib/whatsapp-outbox.ts`
- Modify: `src/backend/lib/whatsapp-outbox.test.ts`

- [ ] **Step 1: Append the failing test**

```ts
import { type UltraMsgMessage } from './ultramsg';

describe('pollWhatsappDeliveryIfDue', () => {
  test('advances sent -> delivered -> read by matching provider_message_id', async () => {
    const id = outbox.enqueueWhatsapp({ toPhone: '+2389912233', kind: 'text', body: 'ola' });
    db.prepare(`UPDATE whatsapp_outbox SET status='sent', provider_message_id='mid-9' WHERE id=?`).run(id);

    const fetchSent = async (): Promise<UltraMsgMessage[]> => [{ id: 'mid-9', ack: 'device' }];
    let r = await outbox.pollWhatsappDeliveryIfDue(new Date(), { fetchSent });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/whatsapp-outbox.test.ts`
Expected: FAIL — `pollWhatsappDeliveryIfDue` missing.

- [ ] **Step 3: Implement (append to `whatsapp-outbox.ts`)**

```ts
import { fetchUltraMsgSentMessages, mapAckToStatus, type UltraMsgMessage } from './ultramsg';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/whatsapp-outbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/whatsapp-outbox.ts src/backend/lib/whatsapp-outbox.test.ts
git commit -m "feat(whatsapp): delivery-status poller (sent->delivered->read, no regress)"
```

---

## Task 6: Routes — enqueue manual send + payment document send

**Files:**
- Modify: `src/backend/routes/whatsapp.ts`
- Test: `src/backend/routes/whatsapp.test.ts`

- [ ] **Step 1: Write the failing test (append to `whatsapp.test.ts`)**

```ts
describe('WhatsApp outbox routes', () => {
  test('POST /api/whatsapp/send enqueues and processes the row', async () => {
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();

    const response = await app.inject({
      method: 'POST', url: '/api/whatsapp/send',
      payload: { phone: '9912233', body: 'ola' }
    });
    expect(response.statusCode).toBe(200);
    const n = db.prepare('SELECT COUNT(*) AS n FROM whatsapp_outbox').get() as { n: number };
    expect(n.n).toBe(1);
  });

  test('POST /api/payments/:id/whatsapp enqueues a document row', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C0001','Ana','9912233','active')`).run().lastInsertRowid as number;
    const paymentId = db.prepare(`
      INSERT INTO payments (client_id, reference_month, amount_cve, due_date, status)
      VALUES (?, '2026-05', 4500, '2026-05-10', 'paid')
    `).run(clientId).lastInsertRowid as number;
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();

    const response = await app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/whatsapp`,
      payload: { kind: 'receipt' }
    });
    expect(response.statusCode).toBe(200);
    const row = db.prepare('SELECT kind, doc_payment_id, doc_kind FROM whatsapp_outbox').get() as { kind: string; doc_payment_id: number; doc_kind: string };
    expect(row.kind).toBe('document');
    expect(row.doc_payment_id).toBe(paymentId);
    expect(row.doc_kind).toBe('receipt');
  });

  test('POST /api/payments/:id/whatsapp rejects a client without phone', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C0002','Sem Fone', NULL,'active')`).run().lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, reference_month, amount_cve, due_date, status) VALUES (?, '2026-05', 4500, '2026-05-10', 'paid')`).run(clientId).lastInsertRowid as number;
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgInstanceId','i1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES ('ultraMsgToken','t1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/whatsapp`, payload: { kind: 'receipt' } });
    expect(response.statusCode).toBe(400);
  });
});
```

> Check the top of `whatsapp.test.ts`: ensure `beforeEach` clears `whatsapp_outbox`, `payments`, `clients`, and `app_settings`. If those `DELETE`s are missing, add them (child tables first).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/routes/whatsapp.test.ts`
Expected: FAIL — new route 404 + no outbox rows.

- [ ] **Step 3: Implement**

In `src/backend/routes/whatsapp.ts`, add imports:

```ts
import { enqueueWhatsapp, runWhatsappOutboxIfDue } from '../lib/whatsapp-outbox';
```

Replace the `app.post('/api/whatsapp/send', ...)` handler body (after the `to` normalization) so it enqueues and processes inline:

```ts
    const id = enqueueWhatsapp({ toPhone: to, kind: 'text', body: parsed.data.body, origin: 'manual' });
    await runWhatsappOutboxIfDue(new Date(), undefined, { onlyId: id });
    const row = getSqliteDatabase().prepare('SELECT status, last_error FROM whatsapp_outbox WHERE id = ?').get(id) as { status: string; last_error: string | null };
    if (row.status === 'failed') {
      return reply.status(502).send({ error: row.last_error || 'Falha no envio' });
    }
    return { ok: true, provider: 'ultramsg', id, status: row.status };
```

Add the document-send route inside `registerWhatsappRoutes` (after the `/send` handler):

```ts
  const sendDocumentSchema = z.object({ kind: z.enum(['invoice', 'receipt']) });

  app.post('/api/payments/:id/whatsapp', canSendMessages, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = sendDocumentSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Pedido invalido' });
    }
    const instanceId = getSetting('ultraMsgInstanceId');
    const token = getSetting('ultraMsgToken');
    if (!instanceId || !token) {
      return reply.status(400).send({ error: 'UltraMsg nao configurado' });
    }
    const payment = getSqliteDatabase().prepare(`
      SELECT py.id AS id, c.id AS clientId, c.phone AS phone
      FROM payments py JOIN clients c ON c.id = py.client_id
      WHERE py.id = ?
    `).get(id) as { id: number; clientId: number; phone: string | null } | undefined;
    if (!payment) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    const to = normalizeUltraMsgPhone(payment.phone || '');
    if (!to) {
      return reply.status(400).send({ error: 'Cliente sem telefone WhatsApp valido' });
    }
    const caption = parsed.data.kind === 'invoice' ? 'A sua fatura.' : 'O seu recibo.';
    const outboxId = enqueueWhatsapp({
      toPhone: to, kind: 'document', body: caption,
      docPaymentId: payment.id, docKind: parsed.data.kind, clientId: payment.clientId, origin: 'manual'
    });
    await runWhatsappOutboxIfDue(new Date(), undefined, { onlyId: outboxId });
    const row = getSqliteDatabase().prepare('SELECT status, last_error FROM whatsapp_outbox WHERE id = ?').get(outboxId) as { status: string; last_error: string | null };
    if (row.status === 'failed') {
      return reply.status(502).send({ error: row.last_error || 'Falha no envio do documento' });
    }
    return { ok: true, id: outboxId, status: row.status };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/routes/whatsapp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/whatsapp.ts src/backend/routes/whatsapp.test.ts
git commit -m "feat(whatsapp): /send enqueues+processes; POST /api/payments/:id/whatsapp sends document"
```

---

## Task 7: Route notices through the outbox

**Files:**
- Modify: `src/backend/lib/notices.ts`
- Test: `src/backend/lib/notices.test.ts`

- [ ] **Step 1: Adjust the failing test**

In `src/backend/lib/notices.test.ts`, the existing tests inject a `send` fake and assert on `whatsapp_notices`. Update them to assert that eligible candidates are **enqueued** to `whatsapp_outbox` (the notices row is still written for dedup). Replace the "sends ... notices" assertions with:

```ts
  test('enqueues an outbox row per eligible candidate and logs the notice for dedup', async () => {
    // (existing seed of an overdue payment + enabled settings stays the same)
    const result = await runOverdueNoticesIfDue(new Date());
    expect('ran' in result && result.ran).toBe(true);
    const outbox = db.prepare(`SELECT origin, kind FROM whatsapp_outbox`).all() as Array<{ origin: string; kind: string }>;
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox.every((r) => r.origin === 'auto' && r.kind === 'text')).toBe(true);
    const notices = db.prepare(`SELECT outbox_id FROM whatsapp_notices`).all() as Array<{ outbox_id: number | null }>;
    expect(notices.every((n) => n.outbox_id !== null)).toBe(true);
  });
```

Keep the cooldown-dedupe test, but assert it does NOT enqueue a second time on the cooldown day:

```ts
  test('cooldown dedupe avoids enqueuing the same notice type again', async () => {
    // day 1 run (existing seed) ...
    await runOverdueNoticesIfDue(today);
    const afterDay1 = (db.prepare('SELECT COUNT(*) AS n FROM whatsapp_outbox').get() as { n: number }).n;
    await runOverdueNoticesIfDue(tomorrow); // resets daily guard but cooldown still applies
    const afterDay2 = (db.prepare('SELECT COUNT(*) AS n FROM whatsapp_outbox').get() as { n: number }).n;
    expect(afterDay2).toBe(afterDay1);
  });
```

> Also ensure the test's `beforeEach` clears `whatsapp_outbox` before `whatsapp_notices` (child order). Remove the now-unused `send` fake injection where assertions changed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/notices.test.ts`
Expected: FAIL — still sending synchronously, no outbox rows / no `outbox_id`.

- [ ] **Step 3: Implement**

In `src/backend/lib/notices.ts`:

Add import:

```ts
import { enqueueWhatsapp } from './whatsapp-outbox';
```

Change `logNotice` to capture `outbox_id` and remove the synchronous send. Replace the loop body (the part from `const result = await send(...)` through the `delay`) with enqueue logic, and change `logNotice` to:

```ts
  const logNotice = db.prepare(`
    INSERT INTO whatsapp_notices (payment_id, client_id, notice_type, origin, phone, body, status, error, outbox_id)
    VALUES (?, ?, ?, 'auto', ?, ?, 'sent', NULL, ?)
  `);
```

Replace the per-candidate send block with:

```ts
    const outboxId = enqueueWhatsapp({
      toPhone: to, kind: 'text', body, clientId: row.clientId, origin: 'auto'
    });
    sent += 1;
    logNotice.run(row.paymentId, row.clientId, type, to, body, outboxId);
```

Remove the now-unused `send`/`SEND_INTERVAL_MS`/`delay` usages and the `NoticeSender` injection if no longer referenced (keep `NoticeSender` export only if other code imports it; otherwise delete it). Drop the trailing `await delay(...)`. The `failed` counter stays 0 here (delivery now happens in the worker), so simplify the return to `{ ran: true, date: todayIso, enqueued: sent, skipped }` — and update the `OverdueNoticesRun` type accordingly:

```ts
export type OverdueNoticesRun =
  | { skipped: true; reason: string }
  | { ran: true; date: string; enqueued: number; skipped: number };
```

Update the boot caller note in Task 8 accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/notices.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/notices.ts src/backend/lib/notices.test.ts
git commit -m "refactor(notices): enqueue to whatsapp outbox instead of sending synchronously"
```

---

## Task 8: Boot scheduling

**Files:**
- Modify: `src/backend/server.ts`

- [ ] **Step 1: Schedule the worker + poller**

In `src/backend/server.ts`, add the import near the other lib imports:

```ts
import { pollWhatsappDeliveryIfDue, runWhatsappOutboxIfDue } from './lib/whatsapp-outbox';
```

Near where `runOverdueNoticesIfDue()` is invoked on boot, add interval-driven processing (off-switch via env, never blocks boot):

```ts
  // WhatsApp outbox: drain the queue and poll delivery status on intervals.
  // Opt-out with ISPM_WHATSAPP_OUTBOX=off. Errors are swallowed so a transient
  // provider/network failure never crashes the backend.
  if (process.env.ISPM_WHATSAPP_OUTBOX !== 'off') {
    const drain = () => { void runWhatsappOutboxIfDue().catch(() => undefined); };
    const poll = () => { void pollWhatsappDeliveryIfDue().catch(() => undefined); };
    drain();
    setInterval(drain, 60_000).unref();
    setInterval(poll, 180_000).unref();
  }
```

> Use `.unref()` so the timers never keep the process alive on shutdown. Place this after `app.ready()`/inside `createBackendApp` alongside the existing boot jobs, matching how `runOverdueNoticesIfDue` is wired.

- [ ] **Step 2: Verify typecheck (main + node)**

Run: `npm.cmd run typecheck`
Run: `npx.cmd tsc -p tsconfig.main.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/backend/server.ts
git commit -m "feat(whatsapp): schedule outbox worker + delivery poller on boot"
```

---

## Task 9: Renderer — "Enviar por WhatsApp" on a payment

**Files:**
- Modify: `src/renderer/modules/PaymentsModule.tsx`

- [ ] **Step 1: Locate the document preview actions**

Run: `git grep -n "invoice.pdf\|receipt.pdf\|authFetch\|preview" src/renderer/modules/PaymentsModule.tsx`
Read the section that renders the document preview / per-payment actions to match its `Button` usage and the selected-payment variable name.

- [ ] **Step 2: Add a send handler**

Add inside the `PaymentsModule` component (mirror the existing fetch/toast pattern in that file; use the file's existing toast/error mechanism — `useToast` or local state):

```tsx
  async function sendDocumentWhatsapp(paymentId: number, kind: 'invoice' | 'receipt') {
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${paymentId}/whatsapp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || 'Nao foi possivel enviar por WhatsApp');
      }
      // success feedback via the module's existing toast/message mechanism
    } catch (err) {
      // surface err.message via the module's existing toast/message mechanism
    }
  }
```

Wire the success/error lines to whatever feedback primitive the file already uses (e.g. `toast(...)` or `setMessage(...)`) — match the file, do not introduce a new mechanism.

- [ ] **Step 3: Add the button**

In the document preview/actions area for a paid payment, add next to the existing "Recibo"/"Fatura" actions (use the `kind` matching what's shown — `receipt` when paid, else `invoice`):

```tsx
<Button
  variant="ghost"
  size="sm"
  leadingIcon={<MessageCircle size={16} />}
  onClick={() => void sendDocumentWhatsapp(payment.id, payment.status === 'paid' ? 'receipt' : 'invoice')}
>
  Enviar por WhatsApp
</Button>
```

Add `MessageCircle` to the existing `lucide-react` import if not already imported.

- [ ] **Step 4: Typecheck**

Run: `npm.cmd run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/modules/PaymentsModule.tsx
git commit -m "feat(payments): send invoice/receipt PDF by WhatsApp from the document preview"
```

---

## Task 10: Full validation + docs

**Files:**
- Modify: `.specs/project/STATE.md` (local-only; `.specs` is gitignored — edit, do not git add)

- [ ] **Step 1: Full validation**

```bash
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test -- --no-file-parallelism
```

Expected: all PASS.

- [ ] **Step 2: Manual smoke (dev)**

`npm.cmd run dev`. In Configurações set a real UltraMsg instance/token (or leave empty to confirm graceful skip). Send a manual message and a payment receipt; confirm a `whatsapp_outbox` row reaches `sent`, and that status advances on the next poll.

- [ ] **Step 3: Update STATE.md**

Add a "Completed" bullet for the WhatsApp outbox (PDF attach, retries, delivery polling) and note Fase 2 (multi-provider) as the next candidate.

---

## Self-Review Notes

- **Spec coverage:** outbox table (T2) ✓; PDF attach via base64 (T1 transport + T4 worker + T9 UI) ✓; retries/backoff + queue (T4) ✓; delivery polling, no-regress (T1 + T5) ✓; manual send enqueue+inline (T6) ✓; notices→enqueue with `outbox_id` link (T7) ✓; boot scheduling + `ISPM_WHATSAPP_OUTBOX` toggle (T8) ✓; `renderPaymentDocumentPdf` reuse (T3) ✓; phase-2 seam = `OutboxDeps.sendText/sendDocument` dispatch boundary ✓.
- **Refinement vs spec:** when UltraMsg is unconfigured the worker/poller **skip** (leave rows pending) rather than failing rows — avoids burning attempts on transient misconfiguration. The `/api/...` routes still return 400 when unconfigured.
- **Type consistency:** `UltraMsgSendResult.messageId`, `UltraMsgMessage{id,ack}`, `OutboxDeps{sendText,sendDocument,renderPdf}`, `PollDeps{fetchSent}`, `WhatsappOutboxEntry`, `renderPaymentDocumentPdf(id,kind)→{buffer,filename}` are used identically across tasks.
- **No 403 test:** route tests run `ISPM_AUTH='off'`; role enforcement covered by `auth.test.ts` (precedent).
