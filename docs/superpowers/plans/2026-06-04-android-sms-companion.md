# Android SMS Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SMS notifications through a paired Android phone on the same local network, with manual approval on Android before the phone sends SMS through its SIM.

**Architecture:** The ISPM desktop backend owns the durable `sms_outbox`, templates, pairing settings, HMAC request signing, retry/backoff, and status polling. A new Android companion app exposes a small authenticated local HTTP API, persists incoming requests, requires operator approval, sends SMS via Android APIs, and reports status back to the desktop. The desktop UI surfaces SMS configuration, pairing, test sends, and payment-level SMS actions.

**Tech Stack:** Fastify 5, better-sqlite3, Zod, Vitest, React 19, QRCode package already present; Android Kotlin, Gradle Android plugin, Jetpack Compose, OkHttp embedded HTTP server or lightweight NanoHTTPD, Android SMS APIs.

---

## Scope Check

The approved spec spans desktop backend, desktop UI, and Android companion. Keep this as one plan because Fase 1 must prove the complete loop: desktop enqueue -> dispatch to Android -> Android approval -> SMS send -> status reflected in desktop. Each task below is independently committable and testable.

## File Structure

Desktop backend:

- Create `src/shared/sms.ts` - SMS event types, fallback templates, phone normalization, template rendering.
- Create `src/backend/db/migrations/0016_sms_companion.ts` - `sms_outbox`, pairing metadata, indexes.
- Modify `src/backend/db/migrations/index.ts` - append migration 16.
- Create `src/backend/lib/sms-signing.ts` - HMAC signing/verification helpers shared by routes/transport tests.
- Create `src/backend/lib/sms-outbox.ts` - enqueue, dispatch to Android, poll Android status, retry/backoff.
- Create `src/backend/lib/sms-outbox.test.ts` - worker tests with injected fake Android transport.
- Create `src/backend/routes/sms.ts` - settings, pairing QR payload, test enqueue, payment SMS enqueue, status list.
- Create `src/backend/routes/sms.test.ts` - route and auth tests.
- Modify `src/backend/server.ts` - register SMS routes and schedule SMS dispatch/poll workers.
- Modify `src/backend/routes/settings.ts` - include SMS template/settings keys in `/api/settings`.

Desktop renderer:

- Modify `src/renderer/modules/SettingsModule.tsx` - add `SMS` tab with pairing/status/templates/test send.
- Modify `src/renderer/modules/PaymentsModule.tsx` - add SMS actions for FT/FR/atraso/suspensao.
- Modify `src/renderer/types.ts` - add SMS status/event types used by UI.
- Modify `src/renderer/styles.css` - focused layout for SMS settings/status blocks.

Android companion:

- Create `android-sms-companion/settings.gradle.kts`
- Create `android-sms-companion/build.gradle.kts`
- Create `android-sms-companion/app/build.gradle.kts`
- Create `android-sms-companion/app/src/main/AndroidManifest.xml`
- Create `android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/MainActivity.kt`
- Create `android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/PairingStore.kt`
- Create `android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/SmsRequestStore.kt`
- Create `android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/CompanionServer.kt`
- Create `android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/SmsSender.kt`
- Create `android-sms-companion/app/src/test/java/cv/novatech/ispm/sms/SignatureTest.kt`

Validation:

- `npm.cmd run typecheck`
- `npm.cmd test`
- `npm.cmd run lint`
- `npx.cmd tsc -p tsconfig.main.json`
- Android: `.\gradlew.bat test` from `android-sms-companion` when Android toolchain is installed.

---

## Task 1: Shared SMS Templates and Phone Normalization

**Files:**
- Create: `src/shared/sms.ts`
- Test: `src/shared/sms.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/sms.test.ts
import { describe, expect, test } from 'vitest';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  normalizeSmsPhone,
  renderSmsTemplate
} from './sms';

describe('normalizeSmsPhone', () => {
  test('normalizes Cabo Verde local numbers to +238', () => {
    expect(normalizeSmsPhone('991 22 33')).toBe('+2389912233');
  });

  test('keeps numbers that already include the country code', () => {
    expect(normalizeSmsPhone('+238 991 22 33')).toBe('+2389912233');
  });

  test('rejects empty phone values', () => {
    expect(normalizeSmsPhone('')).toBe('');
  });
});

describe('renderSmsTemplate', () => {
  test('renders invoice issued messages with stable placeholders', () => {
    expect(renderSmsTemplate(fallbackSmsInvoiceIssuedTemplate, {
      fullName: 'Ana Lopes',
      clientCode: 'CLT-001',
      amountCve: 4500,
      dueDate: '2026-06-10',
      referenceMonth: '2026-06',
      invoiceNumber: 'FT-2026-001'
    }, 'ISPM')).toContain('FT-2026-001');
  });

  test('renders overdue days and suspension threshold', () => {
    expect(renderSmsTemplate(fallbackSmsPaymentOverdueTemplate, {
      fullName: 'Ana Lopes',
      clientCode: 'CLT-001',
      amountCve: 4500,
      dueDate: '2026-06-10',
      referenceMonth: '2026-06',
      invoiceNumber: 'FT-2026-001',
      daysOverdue: 7,
      suspensionDays: 15
    }, 'ISPM')).toContain('7');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx.cmd vitest run src/shared/sms.test.ts`

Expected: FAIL because `src/shared/sms.ts` does not exist.

- [ ] **Step 3: Implement shared SMS helpers**

```ts
// src/shared/sms.ts
export type SmsEventType = 'invoice_issued' | 'receipt_confirmed' | 'payment_overdue' | 'suspension_notice';

export const fallbackSmsInvoiceIssuedTemplate = 'Ola {nome}, a sua fatura {fatura} de {mes}, no valor de {valor} CVE, foi emitida. Vencimento: {vencimento}. {empresa}';
export const fallbackSmsReceiptConfirmedTemplate = 'Ola {nome}, confirmamos o recebimento de {valor} CVE referente a {mes}. Recibo {recibo}. Obrigado, {empresa}.';
export const fallbackSmsPaymentOverdueTemplate = 'Ola {nome}, a fatura {fatura} esta em atraso ha {dias_atraso} dia(s). Valor: {valor} CVE. Regularize para evitar constrangimentos. {empresa}';
export const fallbackSmsSuspensionNoticeTemplate = 'Ola {nome}, a fatura {fatura} continua em atraso. O servico podera ser suspenso apos {dias_suspensao} dia(s) de atraso. {empresa}';

export type SmsTemplateData = {
  fullName: string;
  clientCode: string | null;
  phone?: string | null;
  amountCve?: number;
  dueDate?: string | null;
  referenceMonth?: string | null;
  invoiceNumber?: string | null;
  receiptNumber?: string | null;
  daysOverdue?: number;
  suspensionDays?: number;
};

export function normalizeSmsPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('238')) return `+${digits}`;
  if (digits.length === 7) return `+238${digits}`;
  return `+${digits}`;
}

export function renderSmsTemplate(template: string, data: SmsTemplateData, companyName: string): string {
  return template
    .replace(/\{nome\}/gi, data.fullName || '-')
    .replace(/\{cliente\}/gi, data.fullName || '-')
    .replace(/\{codigo\}/gi, data.clientCode || '-')
    .replace(/\{telefone\}/gi, data.phone || '')
    .replace(/\{empresa\}/gi, companyName || 'ISPM')
    .replace(/\{valor\}/gi, data.amountCve == null ? '-' : String(data.amountCve))
    .replace(/\{vencimento\}/gi, data.dueDate || '-')
    .replace(/\{mes\}/gi, data.referenceMonth || '-')
    .replace(/\{fatura\}/gi, data.invoiceNumber || '-')
    .replace(/\{recibo\}/gi, data.receiptNumber || '-')
    .replace(/\{dias_atraso\}/gi, data.daysOverdue == null ? '-' : String(data.daysOverdue))
    .replace(/\{dias_suspensao\}/gi, data.suspensionDays == null ? '-' : String(data.suspensionDays));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx.cmd vitest run src/shared/sms.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/sms.ts src/shared/sms.test.ts
git commit -m "feat(sms): add shared templates and phone normalization"
```

---

## Task 2: SMS Outbox Migration and Settings Defaults

**Files:**
- Create: `src/backend/db/migrations/0016_sms_companion.ts`
- Modify: `src/backend/db/migrations/index.ts`
- Modify: `src/backend/routes/settings.ts`
- Test: `src/backend/db/migrate.test.ts`, `src/backend/routes/settings.test.ts` if present; otherwise route tests in Task 6 cover settings.

- [ ] **Step 1: Write migration test expectations**

Add this assertion to `src/backend/db/migrate.test.ts` after the migration runner creates a database:

```ts
const smsOutbox = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_outbox'").get();
expect(smsOutbox).toBeTruthy();

const smsPairing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_companion_pairing'").get();
expect(smsPairing).toBeTruthy();
```

- [ ] **Step 2: Run migration tests to verify they fail**

Run: `npx.cmd vitest run src/backend/db/migrate.test.ts`

Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Create migration 0016**

```ts
// src/backend/db/migrations/0016_sms_companion.ts
import type { Migration } from './types';

const migration: Migration = {
  version: 16,
  name: 'sms_companion',
  sql: `
    CREATE TABLE IF NOT EXISTS sms_companion_pairing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_name TEXT,
      base_url TEXT,
      pairing_key_hash TEXT,
      paired_at TEXT,
      revoked_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sms_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      payment_id INTEGER REFERENCES payments(id),
      service_id INTEGER REFERENCES services(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('invoice_issued','receipt_confirmed','payment_overdue','suspension_notice','test')),
      to_phone TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_dispatch','pending_approval','approved','sent','failed','rejected','cancelled')) DEFAULT 'pending_dispatch',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      next_attempt_at TEXT,
      android_request_id TEXT,
      approved_at TEXT,
      sent_at TEXT,
      rejected_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sms_outbox_ready ON sms_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_sms_outbox_payment_event ON sms_outbox(payment_id, event_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_outbox_android_request ON sms_outbox(android_request_id) WHERE android_request_id IS NOT NULL;
  `
};

export default migration;
```

- [ ] **Step 4: Register migration**

Modify `src/backend/db/migrations/index.ts`:

```ts
import m0016 from './0016_sms_companion';

export const migrations: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016];
```

- [ ] **Step 5: Add settings defaults/schema**

In `src/backend/routes/settings.ts`, import SMS fallbacks:

```ts
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate
} from '../../shared/sms';
```

Extend `settingsSchema`:

```ts
smsCompanionEnabled: z.coerce.boolean().optional().default(false),
smsCompanionBaseUrl: z.string().trim().max(255).optional().nullable(),
smsDispatchIntervalSeconds: z.coerce.number().int().min(15).max(3600).optional().default(60),
smsRetryGraceMinutes: z.coerce.number().int().min(1).max(1440).optional().default(5),
smsInvoiceIssuedTemplate: z.string().trim().max(320).optional().nullable(),
smsReceiptConfirmedTemplate: z.string().trim().max(320).optional().nullable(),
smsPaymentOverdueTemplate: z.string().trim().max(320).optional().nullable(),
smsSuspensionNoticeTemplate: z.string().trim().max(320).optional().nullable(),
```

Extend `defaultSettings`:

```ts
smsCompanionEnabled: false,
smsCompanionBaseUrl: '',
smsDispatchIntervalSeconds: 60,
smsRetryGraceMinutes: 5,
smsInvoiceIssuedTemplate: fallbackSmsInvoiceIssuedTemplate,
smsReceiptConfirmedTemplate: fallbackSmsReceiptConfirmedTemplate,
smsPaymentOverdueTemplate: fallbackSmsPaymentOverdueTemplate,
smsSuspensionNoticeTemplate: fallbackSmsSuspensionNoticeTemplate,
```

Update settings parsing branches:

```ts
} else if (row.key === 'smsDispatchIntervalSeconds' || row.key === 'smsRetryGraceMinutes') {
  const n = Number(row.value);
  settings[row.key] = Number.isFinite(n) ? n as never : defaultSettings[row.key] as never;
} else if (row.key === 'showIva' || row.key === 'printQrCode' || row.key === 'autoNoticesEnabled' || row.key === 'smsCompanionEnabled') {
  settings[row.key] = (row.value === 'true' || row.value === '1') as never;
```

- [ ] **Step 6: Run migration/settings validation**

Run:

```bash
npx.cmd vitest run src/backend/db/migrate.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backend/db/migrations/0016_sms_companion.ts src/backend/db/migrations/index.ts src/backend/db/migrate.test.ts src/backend/routes/settings.ts
git commit -m "feat(sms): add companion outbox schema and settings"
```

---

## Task 3: HMAC Signing for Desktop and Android Requests

**Files:**
- Create: `src/backend/lib/sms-signing.ts`
- Test: `src/backend/lib/sms-signing.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/backend/lib/sms-signing.test.ts
import { describe, expect, test } from 'vitest';
import { createSmsSignature, timingSafeEqualString, verifySmsSignature } from './sms-signing';

describe('sms signing', () => {
  test('verifies a valid signature', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{"hello":"world"}'
    };
    const signature = createSmsSignature(input);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:00:30.000Z') })).toBe(true);
  });

  test('rejects expired timestamps', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const signature = createSmsSignature(input);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:06:00.000Z') })).toBe(false);
  });

  test('uses constant-time comparison for equal strings', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx.cmd vitest run src/backend/lib/sms-signing.test.ts`

Expected: FAIL because `sms-signing.ts` does not exist.

- [ ] **Step 3: Implement signing helper**

```ts
// src/backend/lib/sms-signing.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SmsSignatureInput = {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
};

function canonical(input: SmsSignatureInput) {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.body
  ].join('\n');
}

export function createSmsSignature(input: SmsSignatureInput): string {
  return createHmac('sha256', input.secret).update(canonical(input)).digest('hex');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifySmsSignature(input: SmsSignatureInput & { signature: string; now?: Date; maxSkewMs?: number }): boolean {
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const skew = Math.abs((input.now ?? new Date()).getTime() - timestampMs);
  if (skew > (input.maxSkewMs ?? 5 * 60_000)) return false;
  return timingSafeEqualString(createSmsSignature(input), input.signature);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx.cmd vitest run src/backend/lib/sms-signing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/sms-signing.ts src/backend/lib/sms-signing.test.ts
git commit -m "feat(sms): add companion request signing"
```

---

## Task 4: SMS Outbox Engine

**Files:**
- Create: `src/backend/lib/sms-outbox.ts`
- Test: `src/backend/lib/sms-outbox.test.ts`

- [ ] **Step 1: Write failing engine tests**

```ts
// src/backend/lib/sms-outbox.test.ts
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
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    const row = db.prepare('SELECT status FROM sms_outbox WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('pending_dispatch');
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx.cmd vitest run src/backend/lib/sms-outbox.test.ts`

Expected: FAIL because `sms-outbox.ts` does not exist.

- [ ] **Step 3: Implement outbox engine**

Create `src/backend/lib/sms-outbox.ts` with these public APIs:

```ts
import { randomUUID } from 'node:crypto';
import { getSqliteDatabase } from '../db/database';
import type { SmsEventType } from '../../shared/sms';

export type SmsOutboxStatus = 'pending_dispatch' | 'pending_approval' | 'approved' | 'sent' | 'failed' | 'rejected' | 'cancelled';
export type SmsDispatchResult = { ok: true; androidRequestId: string } | { ok: false; error: string };
export type SmsStatusResult = { status: SmsOutboxStatus; error?: string };

export type SmsOutboxDeps = {
  postRequest: (entry: { id: number; requestId: string; toPhone: string; body: string; eventType: SmsEventType | 'test' }) => Promise<SmsDispatchResult>;
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

async function defaultPostRequest(): Promise<SmsDispatchResult> {
  return { ok: false, error: 'Transporte Android ainda nao configurado' };
}

async function defaultFetchStatus(): Promise<SmsStatusResult> {
  return { status: 'pending_approval' };
}

const defaultDeps: SmsOutboxDeps = { postRequest: defaultPostRequest, fetchStatus: defaultFetchStatus };

export async function runSmsOutboxIfDue(now: Date = new Date(), deps: SmsOutboxDeps = defaultDeps): Promise<{ dispatched: number; retried: number; skipped?: string }> {
  if (getSetting('smsCompanionEnabled') !== 'true') return { dispatched: 0, retried: 0, skipped: 'SMS companion desativado' };
  const db = getSqliteDatabase();
  const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(`
    SELECT id, event_type AS eventType, to_phone AS toPhone, body, attempts, max_attempts AS maxAttempts
    FROM sms_outbox
    WHERE status='pending_dispatch' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY id ASC LIMIT 20
  `).all(nowIso) as Array<{ id: number; eventType: SmsEventType | 'test'; toPhone: string; body: string; attempts: number; maxAttempts: number }>;

  let dispatched = 0;
  let retried = 0;
  for (const row of rows) {
    const requestId = randomUUID();
    const result = await deps.postRequest({ id: row.id, requestId, toPhone: row.toPhone, body: row.body, eventType: row.eventType });
    if (result.ok) {
      db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id=?, last_error=NULL, next_attempt_at=NULL, updated_at=datetime('now') WHERE id=?`).run(result.androidRequestId, row.id);
      dispatched += 1;
    } else {
      const attemptsAfter = row.attempts + 1;
      if (attemptsAfter >= row.maxAttempts) {
        db.prepare(`UPDATE sms_outbox SET status='failed', attempts=attempts+1, last_error=?, updated_at=datetime('now') WHERE id=?`).run(result.error, row.id);
      } else {
        const next = new Date(now.getTime() + backoffMinutes(attemptsAfter) * 60_000).toISOString().replace('T', ' ').slice(0, 19);
        db.prepare(`UPDATE sms_outbox SET attempts=attempts+1, last_error=?, next_attempt_at=?, updated_at=datetime('now') WHERE id=?`).run(result.error, next, row.id);
      }
      retried += 1;
    }
  }
  return { dispatched, retried };
}

export async function pollSmsStatusIfDue(_now: Date = new Date(), deps: SmsOutboxDeps = defaultDeps): Promise<{ updated: number }> {
  const db = getSqliteDatabase();
  const rows = db.prepare(`SELECT id, android_request_id AS androidRequestId FROM sms_outbox WHERE status IN ('pending_approval','approved') AND android_request_id IS NOT NULL`).all() as Array<{ id: number; androidRequestId: string }>;
  let updated = 0;
  for (const row of rows) {
    const result = await deps.fetchStatus(row.androidRequestId);
    if (!['approved', 'sent', 'failed', 'rejected'].includes(result.status)) continue;
    const column = result.status === 'sent' ? 'sent_at' : result.status === 'rejected' ? 'rejected_at' : result.status === 'approved' ? 'approved_at' : null;
    if (column) {
      db.prepare(`UPDATE sms_outbox SET status=?, ${column}=datetime('now'), last_error=?, updated_at=datetime('now') WHERE id=?`).run(result.status, result.error ?? null, row.id);
    } else {
      db.prepare(`UPDATE sms_outbox SET status=?, last_error=?, updated_at=datetime('now') WHERE id=?`).run(result.status, result.error ?? null, row.id);
    }
    updated += 1;
  }
  return { updated };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx.cmd vitest run src/backend/lib/sms-outbox.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/sms-outbox.ts src/backend/lib/sms-outbox.test.ts
git commit -m "feat(sms): add durable SMS outbox engine"
```

---

## Task 5: Android Companion Transport

**Files:**
- Modify: `src/backend/lib/sms-outbox.ts`
- Test: `src/backend/lib/sms-outbox.test.ts`

- [ ] **Step 1: Add transport test**

Append to `src/backend/lib/sms-outbox.test.ts`:

```ts
test('default transport posts signed request to Android companion', async () => {
  db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionPairingKey','secret')`).run();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'android-1' }) };
  }));

  const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
  await runSmsOutboxIfDue(new Date());

  expect(calls[0].url).toBe('http://192.168.1.50:8765/requests');
  expect((calls[0].init.headers as Record<string, string>)['x-ispm-signature']).toBeTruthy();
  const row = db.prepare('SELECT status FROM sms_outbox WHERE id=?').get(id) as { status: string };
  expect(row.status).toBe('pending_approval');
});
```

Add `import { vi } from 'vitest';` and `afterEach(() => vi.unstubAllGlobals());`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/sms-outbox.test.ts`

Expected: FAIL because default transport returns "not configured".

- [ ] **Step 3: Implement default HTTP transport**

In `src/backend/lib/sms-outbox.ts`, import signing:

```ts
import { createSmsSignature } from './sms-signing';
```

Replace `defaultPostRequest` and `defaultFetchStatus`:

```ts
function pairingSecret(): string {
  return getSetting('smsCompanionPairingKey');
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return { error: text };
  }
}

async function signedFetch(path: string, method: 'GET' | 'POST', bodyObject?: unknown): Promise<Response> {
  const baseUrl = getSetting('smsCompanionBaseUrl');
  const secret = pairingSecret();
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

async function defaultPostRequest(entry: { requestId: string; toPhone: string; body: string; eventType: SmsEventType | 'test' }): Promise<SmsDispatchResult> {
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
    return { status: String(json.status || 'pending_approval') as SmsOutboxStatus, error: typeof json.error === 'string' ? json.error : undefined };
  } catch (err) {
    return { status: 'pending_approval', error: err instanceof Error ? err.message : 'Android companion offline' };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx.cmd vitest run src/backend/lib/sms-outbox.test.ts src/backend/lib/sms-signing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/sms-outbox.ts src/backend/lib/sms-outbox.test.ts
git commit -m "feat(sms): dispatch signed requests to Android companion"
```

---

## Task 6: Backend SMS Routes

**Files:**
- Create: `src/backend/routes/sms.ts`
- Create: `src/backend/routes/sms.test.ts`
- Modify: `src/backend/server.ts`

- [ ] **Step 1: Write route tests**

```ts
// src/backend/routes/sms.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-sms-routes-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

describe('SMS routes', () => {
  test('GET /api/sms/status returns pairing and queue counts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sms/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ paired: false, counts: { pendingDispatch: 0, pendingApproval: 0 } });
  });

  test('POST /api/sms/pairing creates a pairing payload', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sms/pairing', payload: { baseUrl: 'http://192.168.1.50:8765', deviceName: 'Android A' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.qrPayload).toContain('ispm-sms://pair');
    expect(body.secret).toBeTruthy();
  });

  test('POST /api/payments/:id/sms enqueues receipt SMS', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C1','Ana','9912233','active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?,4500,10,'active')`).run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status, receipt_number) VALUES (?,?,'2026-06',4500,'2026-06-10','2026-06-04','paid','RC-1')`).run(clientId, serviceId).lastInsertRowid as number;

    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'receipt_confirmed' } });
    expect(response.statusCode).toBe(200);
    const row = db.prepare('SELECT event_type, status, to_phone FROM sms_outbox').get() as { event_type: string; status: string; to_phone: string };
    expect(row).toMatchObject({ event_type: 'receipt_confirmed', status: 'pending_dispatch', to_phone: '+2389912233' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx.cmd vitest run src/backend/routes/sms.test.ts`

Expected: FAIL because routes are not registered.

- [ ] **Step 3: Implement SMS routes**

Create `src/backend/routes/sms.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { requireRole } from './auth';
import { enqueueSmsNotification } from '../lib/sms-outbox';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate,
  normalizeSmsPhone,
  renderSmsTemplate,
  type SmsEventType
} from '../../shared/sms';

const pairingSchema = z.object({
  baseUrl: z.string().url(),
  deviceName: z.string().trim().min(1).max(80)
});

const paymentSmsSchema = z.object({
  eventType: z.enum(['invoice_issued', 'receipt_confirmed', 'payment_overdue', 'suspension_notice'])
});

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

function templateFor(eventType: SmsEventType) {
  const keys: Record<SmsEventType, [string, string]> = {
    invoice_issued: ['smsInvoiceIssuedTemplate', fallbackSmsInvoiceIssuedTemplate],
    receipt_confirmed: ['smsReceiptConfirmedTemplate', fallbackSmsReceiptConfirmedTemplate],
    payment_overdue: ['smsPaymentOverdueTemplate', fallbackSmsPaymentOverdueTemplate],
    suspension_notice: ['smsSuspensionNoticeTemplate', fallbackSmsSuspensionNoticeTemplate]
  };
  const [key, fallback] = keys[eventType];
  return getSetting(key) || fallback;
}

export async function registerSmsRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };
  const canSend = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/sms/status', adminOnly, async () => {
    const db = getSqliteDatabase();
    const row = db.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key='smsCompanionPairingKey' AND value <> ''`).get() as { n: number };
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status='pending_dispatch' THEN 1 ELSE 0 END) AS pendingDispatch,
        SUM(CASE WHEN status='pending_approval' THEN 1 ELSE 0 END) AS pendingApproval,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM sms_outbox
    `).get() as { pendingDispatch: number | null; pendingApproval: number | null; failed: number | null };
    return {
      paired: row.n > 0,
      baseUrl: getSetting('smsCompanionBaseUrl'),
      counts: {
        pendingDispatch: counts.pendingDispatch ?? 0,
        pendingApproval: counts.pendingApproval ?? 0,
        failed: counts.failed ?? 0
      }
    };
  });

  app.post('/api/sms/pairing', adminOnly, async (request, reply) => {
    const parsed = pairingSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Pareamento SMS invalido' });
    const secret = randomBytes(32).toString('hex');
    setSetting('smsCompanionEnabled', 'true');
    setSetting('smsCompanionBaseUrl', parsed.data.baseUrl);
    setSetting('smsCompanionDeviceName', parsed.data.deviceName);
    setSetting('smsCompanionPairingKey', secret);
    setSetting('smsCompanionPairingKeyHash', createHash('sha256').update(secret).digest('hex'));
    const qrPayload = `ispm-sms://pair?baseUrl=${encodeURIComponent('http://127.0.0.1:3001')}&secret=${encodeURIComponent(secret)}&device=${encodeURIComponent(parsed.data.deviceName)}`;
    return { ok: true, secret, qrPayload };
  });

  app.delete('/api/sms/pairing', adminOnly, async () => {
    setSetting('smsCompanionEnabled', 'false');
    setSetting('smsCompanionPairingKey', '');
    setSetting('smsCompanionPairingKeyHash', '');
    return { ok: true };
  });

  app.post('/api/payments/:id/sms', canSend, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = paymentSmsSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) return reply.status(400).send({ error: 'Pedido SMS invalido' });

    const payment = getSqliteDatabase().prepare(`
      SELECT py.id, py.service_id AS serviceId, py.client_id AS clientId, py.reference_month AS referenceMonth,
             py.amount_cve AS amountCve, py.due_date AS dueDate, py.invoice_number AS invoiceNumber,
             py.receipt_number AS receiptNumber, py.status, c.full_name AS fullName,
             c.client_code AS clientCode, c.phone
      FROM payments py JOIN clients c ON c.id = py.client_id
      WHERE py.id = ?
    `).get(id) as {
      id: number; serviceId: number; clientId: number; referenceMonth: string; amountCve: number;
      dueDate: string; invoiceNumber: string | null; receiptNumber: string | null; status: string;
      fullName: string; clientCode: string | null; phone: string | null;
    } | undefined;
    if (!payment) return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    const toPhone = normalizeSmsPhone(payment.phone || '');
    if (!toPhone) return reply.status(400).send({ error: 'Cliente sem telefone SMS valido' });
    if (parsed.data.eventType === 'receipt_confirmed' && payment.status !== 'paid') {
      return reply.status(400).send({ error: 'Recibo SMS exige pagamento pago' });
    }

    const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(`${payment.dueDate}T00:00:00`).getTime()) / 86_400_000));
    const body = renderSmsTemplate(templateFor(parsed.data.eventType), {
      fullName: payment.fullName,
      clientCode: payment.clientCode,
      phone: toPhone,
      amountCve: payment.amountCve,
      dueDate: payment.dueDate,
      referenceMonth: payment.referenceMonth,
      invoiceNumber: payment.invoiceNumber,
      receiptNumber: payment.receiptNumber,
      daysOverdue,
      suspensionDays: Number(getSetting('whatsappSuspensionNoticeDays')) || 15
    }, getSetting('companyName') || 'ISPM');
    const outboxId = enqueueSmsNotification({ clientId: payment.clientId, paymentId: payment.id, serviceId: payment.serviceId, eventType: parsed.data.eventType, toPhone, body });
    return { ok: true, id: outboxId, status: 'pending_dispatch' };
  });
}
```

- [ ] **Step 4: Register route in server**

In `src/backend/server.ts`:

```ts
import { registerSmsRoutes } from './routes/sms';
import { pollSmsStatusIfDue, runSmsOutboxIfDue } from './lib/sms-outbox';
```

Register after WhatsApp routes:

```ts
await registerSmsRoutes(app);
```

Add worker near WhatsApp worker:

```ts
if (process.env.ISPM_SMS_OUTBOX !== 'off' && !process.env.VITEST) {
  const drainSms = () => { void runSmsOutboxIfDue().catch(() => undefined); };
  const pollSms = () => { void pollSmsStatusIfDue().catch(() => undefined); };
  drainSms();
  setInterval(drainSms, 60_000).unref();
  setInterval(pollSms, 60_000).unref();
}
```

- [ ] **Step 5: Run route tests**

Run: `npx.cmd vitest run src/backend/routes/sms.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/routes/sms.ts src/backend/routes/sms.test.ts src/backend/server.ts
git commit -m "feat(sms): add desktop SMS routes and scheduling"
```

---

## Task 7: Desktop SMS UI

**Files:**
- Modify: `src/renderer/modules/SettingsModule.tsx`
- Modify: `src/renderer/modules/PaymentsModule.tsx`
- Modify: `src/renderer/types.ts`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Add renderer types**

In `src/renderer/types.ts`:

```ts
export type SmsEventType = 'invoice_issued' | 'receipt_confirmed' | 'payment_overdue' | 'suspension_notice';

export type SmsStatus = {
  paired: boolean;
  baseUrl: string;
  counts: {
    pendingDispatch: number;
    pendingApproval: number;
    failed: number;
  };
};
```

- [ ] **Step 2: Add SMS tab to SettingsModule**

Change imports:

```ts
import { Banknote, Building2, DatabaseBackup, MessageCircle, Smartphone } from 'lucide-react';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate
} from '../../shared/sms';
import type { SmsStatus } from '../types';
```

Extend tab type and list:

```ts
type SettingsTab = 'company' | 'billing' | 'whatsapp' | 'sms' | 'backups';
{ id: 'sms', label: 'SMS', icon: Smartphone },
```

Extend `SettingsFormState` and initial form:

```ts
smsCompanionEnabled: boolean;
smsCompanionBaseUrl: string;
smsDispatchIntervalSeconds: string;
smsRetryGraceMinutes: string;
smsInvoiceIssuedTemplate: string;
smsReceiptConfirmedTemplate: string;
smsPaymentOverdueTemplate: string;
smsSuspensionNoticeTemplate: string;
```

Initial values:

```ts
smsCompanionEnabled: false,
smsCompanionBaseUrl: '',
smsDispatchIntervalSeconds: '60',
smsRetryGraceMinutes: '5',
smsInvoiceIssuedTemplate: fallbackSmsInvoiceIssuedTemplate,
smsReceiptConfirmedTemplate: fallbackSmsReceiptConfirmedTemplate,
smsPaymentOverdueTemplate: fallbackSmsPaymentOverdueTemplate,
smsSuspensionNoticeTemplate: fallbackSmsSuspensionNoticeTemplate,
```

Load/save numeric conversions:

```ts
smsDispatchIntervalSeconds: String(settings.smsDispatchIntervalSeconds),
smsRetryGraceMinutes: String(settings.smsRetryGraceMinutes)
```

```ts
smsDispatchIntervalSeconds: Number(form.smsDispatchIntervalSeconds),
smsRetryGraceMinutes: Number(form.smsRetryGraceMinutes)
```

- [ ] **Step 3: Add SMS status/pairing state**

Inside `SettingsModule`:

```ts
const [smsStatus, setSmsStatus] = useState<SmsStatus | null>(null);
const [smsPairing, setSmsPairing] = useState<{ baseUrl: string; deviceName: string }>({ baseUrl: '', deviceName: '' });

function loadSmsStatus() {
  return authFetch('http://127.0.0.1:3001/api/sms/status')
    .then((response) => response.ok ? response.json() as Promise<SmsStatus> : null)
    .then(setSmsStatus)
    .catch(() => setSmsStatus(null));
}

async function createSmsPairing() {
  const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(smsPairing)
  });
  const data = await response.json().catch(() => ({})) as { error?: string; qrPayload?: string };
  if (!response.ok) {
    setMessage({ tone: 'error', text: data.error || 'Nao foi possivel parear Android SMS.', placement: 'top' });
    return;
  }
  setMessage({ tone: 'success', text: `QR/codigo de pareamento gerado: ${data.qrPayload}`, placement: 'top' });
  await loadSmsStatus();
}
```

Call `void loadSmsStatus();` in the existing settings `useEffect`.

- [ ] **Step 4: Render SMS settings tab**

Add inside form:

```tsx
{activeTab === 'sms' && (
  <>
    <Toggle
      title="Ativar SMS via Android"
      description="O desktop enfileira SMS e o Android pareado pede aprovacao antes de enviar pelo SIM."
      checked={form.smsCompanionEnabled}
      onChange={(event) => setForm((current) => ({ ...current, smsCompanionEnabled: event.target.checked }))}
    />
    <div className="settings-test-whatsapp" aria-label="Pareamento Android SMS">
      <span>{smsStatus?.paired ? `Pareado: ${smsStatus.baseUrl || 'Android'}` : 'Android nao pareado'}</span>
      <Field label="Endereco do Android" placeholder="http://192.168.1.50:8765" value={smsPairing.baseUrl} onChange={(event) => setSmsPairing((current) => ({ ...current, baseUrl: event.target.value }))} />
      <Field label="Nome do dispositivo" placeholder="Android SMS" value={smsPairing.deviceName} onChange={(event) => setSmsPairing((current) => ({ ...current, deviceName: event.target.value }))} />
      <Button variant="secondary" onClick={() => void createSmsPairing()} disabled={!smsPairing.baseUrl || !smsPairing.deviceName}>Gerar pareamento</Button>
    </div>
    {smsStatus && (
      <Message>
        Fila SMS: {smsStatus.counts.pendingDispatch} por entregar, {smsStatus.counts.pendingApproval} aguardando aprovacao, {smsStatus.counts.failed} falhado(s).
      </Message>
    )}
    <Field label="Intervalo de envio SMS (segundos)" type="number" min={15} max={3600} value={form.smsDispatchIntervalSeconds} onChange={(event) => updateForm('smsDispatchIntervalSeconds', event.target.value)} />
    <Field label="Grace retry SMS (minutos)" type="number" min={1} max={1440} value={form.smsRetryGraceMinutes} onChange={(event) => updateForm('smsRetryGraceMinutes', event.target.value)} />
    <Textarea className="whatsapp-template-field" label="SMS emissao de fatura" rows={templateRows(form.smsInvoiceIssuedTemplate)} value={form.smsInvoiceIssuedTemplate} onChange={(event) => updateForm('smsInvoiceIssuedTemplate', event.target.value)} />
    <Textarea className="whatsapp-template-field" label="SMS confirmacao de recibo" rows={templateRows(form.smsReceiptConfirmedTemplate)} value={form.smsReceiptConfirmedTemplate} onChange={(event) => updateForm('smsReceiptConfirmedTemplate', event.target.value)} />
    <Textarea className="whatsapp-template-field" label="SMS atraso de pagamento" rows={templateRows(form.smsPaymentOverdueTemplate)} value={form.smsPaymentOverdueTemplate} onChange={(event) => updateForm('smsPaymentOverdueTemplate', event.target.value)} />
    <Textarea className="whatsapp-template-field" label="SMS aviso de suspensao" rows={templateRows(form.smsSuspensionNoticeTemplate)} value={form.smsSuspensionNoticeTemplate} onChange={(event) => updateForm('smsSuspensionNoticeTemplate', event.target.value)} />
  </>
)}
```

- [ ] **Step 5: Add payment SMS actions**

In `PaymentsModule.tsx`, import `Smartphone` and shared type:

```ts
import { Smartphone } from 'lucide-react';
import type { SmsEventType } from '../types';
```

Add function:

```ts
async function sendPaymentSms(payment: PaymentRow, eventType: SmsEventType) {
  setSubmitting(true);
  try {
    const response = await authFetch(`http://127.0.0.1:3001/api/payments/${payment.id}/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventType })
    });
    const data = await response.json().catch(() => ({})) as { error?: string; status?: string };
    if (!response.ok) throw new Error(data.error || 'Nao foi possivel enfileirar SMS.');
    const messageText = `SMS criado e aguardando aprovacao no Android para ${payment.clientName}.`;
    setMessage(messageText);
    toast(messageText, 'success');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : 'Nao foi possivel enfileirar SMS.';
    setMessage(errorText);
    toast(errorText, 'error');
  } finally {
    setSubmitting(false);
  }
}
```

Add icon button in each payment row next to WhatsApp PDF action:

```tsx
{p.status !== 'cancelled' && normalizeWhatsappPhone(p.clientPhone) && (
  <Button
    variant="icon"
    size="sm"
    title={p.status === 'paid' ? 'Enviar recibo por SMS' : 'Enviar fatura por SMS'}
    disabled={submitting}
    onClick={() => void sendPaymentSms(p, p.status === 'paid' ? 'receipt_confirmed' : p.status === 'overdue' ? 'payment_overdue' : 'invoice_issued')}
  >
    <Smartphone size={16} aria-hidden />
  </Button>
)}
```

- [ ] **Step 6: Run frontend checks**

Run:

```bash
npm.cmd run lint
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/modules/SettingsModule.tsx src/renderer/modules/PaymentsModule.tsx src/renderer/types.ts src/renderer/styles.css
git commit -m "feat(sms): add desktop SMS companion controls"
```

---

## Task 8: Android Companion Scaffold

**Files:**
- Create Android project files under `android-sms-companion/`

- [ ] **Step 1: Create Gradle project files**

```kotlin
// android-sms-companion/settings.gradle.kts
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}
rootProject.name = "ISPM SMS Companion"
include(":app")
```

```kotlin
// android-sms-companion/build.gradle.kts
plugins {
  id("com.android.application") version "8.7.3" apply false
  id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
```

```kotlin
// android-sms-companion/app/build.gradle.kts
plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "cv.novatech.ispm.sms"
  compileSdk = 35

  defaultConfig {
    applicationId = "cv.novatech.ispm.sms"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
}

dependencies {
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.ui:ui:1.7.5")
  implementation("androidx.compose.material3:material3:1.3.1")
  implementation("org.nanohttpd:nanohttpd:2.3.1")
  testImplementation("junit:junit:4.13.2")
}
```

- [ ] **Step 2: Create manifest**

```xml
<!-- android-sms-companion/app/src/main/AndroidManifest.xml -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.SEND_SMS" />

  <application
    android:allowBackup="false"
    android:label="ISPM SMS"
    android:supportsRtl="true"
    android:theme="@style/Theme.Material3.DayNight.NoActionBar">
    <activity
      android:name=".MainActivity"
      android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="ispm-sms" android:host="pair" />
      </intent-filter>
    </activity>
  </application>
</manifest>
```

- [ ] **Step 3: Create minimal MainActivity**

```kotlin
// android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/MainActivity.kt
package cv.novatech.ispm.sms

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
  private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val pairingStore = PairingStore(this)
    val requestStore = SmsRequestStore(this)
    val server = CompanionServer(pairingStore, requestStore)
    server.start()

    setContent {
      val requests = remember { mutableStateOf(requestStore.list()) }
      MaterialTheme {
        Column(modifier = Modifier.padding(24.dp)) {
          Text("ISPM SMS Companion")
          Text(if (pairingStore.isPaired()) "Pareado" else "Nao pareado")
          Button(onClick = { permissionLauncher.launch(Manifest.permission.SEND_SMS) }) {
            Text("Permitir envio SMS")
          }
          requests.value.filter { it.status == "pending_approval" }.forEach { item ->
            Text("${item.toPhone} - ${item.body}")
            Button(onClick = {
              SmsSender.send(this@MainActivity, item.toPhone, item.body)
              requestStore.updateStatus(item.id, "sent", null)
              requests.value = requestStore.list()
            }) { Text("Aprovar e enviar") }
            Button(onClick = {
              requestStore.updateStatus(item.id, "rejected", "Rejeitado no Android")
              requests.value = requestStore.list()
            }) { Text("Rejeitar") }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Commit scaffold**

```bash
git add android-sms-companion
git commit -m "feat(sms): scaffold Android companion app"
```

---

## Task 9: Android Storage, Signing, Server, and SMS Send

**Files:**
- Create: `PairingStore.kt`, `SmsRequestStore.kt`, `CompanionServer.kt`, `SmsSender.kt`
- Test: `SignatureTest.kt`

- [ ] **Step 1: Implement PairingStore**

```kotlin
// android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/PairingStore.kt
package cv.novatech.ispm.sms

import android.content.Context

class PairingStore(context: Context) {
  private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)

  fun save(secret: String, desktopBaseUrl: String) {
    prefs.edit().putString("secret", secret).putString("desktopBaseUrl", desktopBaseUrl).apply()
  }

  fun secret(): String = prefs.getString("secret", "") ?: ""
  fun isPaired(): Boolean = secret().isNotBlank()
  fun clear() = prefs.edit().clear().apply()
}
```

- [ ] **Step 2: Implement request store**

```kotlin
// android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/SmsRequestStore.kt
package cv.novatech.ispm.sms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class SmsRequest(val id: String, val toPhone: String, val body: String, val eventType: String, val status: String, val error: String?)

class SmsRequestStore(context: Context) {
  private val prefs = context.getSharedPreferences("requests", Context.MODE_PRIVATE)

  fun list(): List<SmsRequest> {
    val raw = prefs.getString("rows", "[]") ?: "[]"
    val array = JSONArray(raw)
    return (0 until array.length()).map { i ->
      val obj = array.getJSONObject(i)
      SmsRequest(obj.getString("id"), obj.getString("toPhone"), obj.getString("body"), obj.getString("eventType"), obj.getString("status"), obj.optString("error").ifBlank { null })
    }
  }

  fun upsert(request: SmsRequest) {
    val rows = list().filter { it.id != request.id } + request
    save(rows)
  }

  fun find(id: String): SmsRequest? = list().firstOrNull { it.id == id }

  fun updateStatus(id: String, status: String, error: String?) {
    save(list().map { if (it.id == id) it.copy(status = status, error = error) else it })
  }

  private fun save(rows: List<SmsRequest>) {
    val array = JSONArray()
    rows.forEach {
      array.put(JSONObject().put("id", it.id).put("toPhone", it.toPhone).put("body", it.body).put("eventType", it.eventType).put("status", it.status).put("error", it.error ?: ""))
    }
    prefs.edit().putString("rows", array.toString()).apply()
  }
}
```

- [ ] **Step 3: Implement SMS sender**

```kotlin
// android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/SmsSender.kt
package cv.novatech.ispm.sms

import android.content.Context
import android.telephony.SmsManager

object SmsSender {
  fun send(context: Context, toPhone: String, body: String) {
    val manager = context.getSystemService(SmsManager::class.java)
    val parts = manager.divideMessage(body)
    manager.sendMultipartTextMessage(toPhone, null, parts, null, null)
  }
}
```

- [ ] **Step 4: Implement companion server**

```kotlin
// android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/CompanionServer.kt
package cv.novatech.ispm.sms

import fi.iki.elonen.NanoHTTPD
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class CompanionServer(private val pairingStore: PairingStore, private val requestStore: SmsRequestStore) : NanoHTTPD(8765) {
  override fun serve(session: IHTTPSession): Response {
    val bodyMap = HashMap<String, String>()
    session.parseBody(bodyMap)
    val body = bodyMap["postData"] ?: ""
    if (!verify(session, body)) return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", """{"error":"assinatura invalida"}""")

    if (session.method == Method.POST && session.uri == "/requests") {
      val json = org.json.JSONObject(body)
      val id = json.getString("requestId")
      requestStore.upsert(SmsRequest(id, json.getString("toPhone"), json.getString("body"), json.getString("eventType"), "pending_approval", null))
      return newFixedLengthResponse(Response.Status.OK, "application/json", """{"id":"$id","status":"pending_approval"}""")
    }

    if (session.method == Method.GET && session.uri.startsWith("/requests/")) {
      val id = session.uri.removePrefix("/requests/")
      val row = requestStore.find(id) ?: return newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", """{"error":"pedido nao encontrado"}""")
      return newFixedLengthResponse(Response.Status.OK, "application/json", """{"id":"${row.id}","status":"${row.status}","error":"${row.error ?: ""}"}""")
    }

    return newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", """{"error":"rota inexistente"}""")
  }

  private fun verify(session: IHTTPSession, body: String): Boolean {
    val secret = pairingStore.secret()
    if (secret.isBlank()) return false
    val timestamp = session.headers["x-ispm-timestamp"] ?: return false
    val nonce = session.headers["x-ispm-nonce"] ?: return false
    val signature = session.headers["x-ispm-signature"] ?: return false
    val canonical = listOf(session.method.name, session.uri, timestamp, nonce, body).joinToString("\n")
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
    val expected = mac.doFinal(canonical.toByteArray()).joinToString("") { "%02x".format(it) }
    return expected == signature
  }
}
```

- [ ] **Step 5: Add signature unit test**

```kotlin
// android-sms-companion/app/src/test/java/cv/novatech/ispm/sms/SignatureTest.kt
package cv.novatech.ispm.sms

import org.junit.Assert.assertEquals
import org.junit.Test
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class SignatureTest {
  @Test fun hmacMatchesDesktopCanonicalFormat() {
    val canonical = listOf("POST", "/requests", "2026-06-04T12:00:00.000Z", "nonce-1", "{}").joinToString("\n")
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec("secret".toByteArray(), "HmacSHA256"))
    val hex = mac.doFinal(canonical.toByteArray()).joinToString("") { "%02x".format(it) }
    assertEquals(64, hex.length)
  }
}
```

- [ ] **Step 6: Run Android tests**

Run from `android-sms-companion`:

```bash
.\gradlew.bat test
```

Expected: PASS when Android SDK/Gradle dependencies are installed. If dependencies must download, request network approval.

- [ ] **Step 7: Commit**

```bash
git add android-sms-companion
git commit -m "feat(sms): receive and approve Android SMS requests"
```

---

## Task 10: End-to-End Verification and Polish

**Files:**
- Modify as needed based on test failures only.
- Documentation: `README.md` or `docs/superpowers/specs/2026-06-04-android-sms-companion-design.md` only if setup notes changed.

- [ ] **Step 1: Run full desktop validation**

```bash
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npx.cmd tsc -p tsconfig.main.json
```

Expected: all PASS.

- [ ] **Step 2: Run Android validation**

```bash
cd android-sms-companion
.\gradlew.bat test
```

Expected: PASS. If Android SDK is absent, record the exact missing toolchain message in the final handoff.

- [ ] **Step 3: Manual local-network smoke test**

1. Install Android app debug build on the phone.
2. Open ISPM desktop.
3. Go to `Configuracoes > SMS`.
4. Enter Android base URL, for example `http://192.168.1.50:8765`.
5. Generate pairing.
6. Save settings.
7. From a paid payment, click `Enviar recibo por SMS`.
8. Confirm the Android app shows the pending SMS.
9. Approve on Android.
10. Confirm desktop status eventually becomes `sent`.

Expected: SMS leaves from the Android SIM after approval; desktop outbox row becomes `sent`.

- [ ] **Step 4: Check audit/security invariants**

Run a readonly DB check:

```bash
node -e "const path=require('path'),os=require('os'),Database=require('better-sqlite3'); const db=new Database(path.join(process.env.APPDATA||os.homedir(),'ISPM','ispm.sqlite'),{readonly:true}); console.log(db.prepare('SELECT status, COUNT(*) n FROM sms_outbox GROUP BY status').all()); db.close();"
```

Expected: pending/sent statuses reflect the manual smoke test; no duplicate rows for the same manual click.

- [ ] **Step 5: Commit final polish**

```bash
git status --short
git add README.md docs/superpowers/specs/2026-06-04-android-sms-companion-design.md
git commit -m "docs(sms): document Android companion setup"
```

Only commit if documentation changed in this task. Do not create an empty commit.

---

## Self-Review

- Spec coverage: covered desktop outbox, local paired Android, manual approval, retry/offline behavior, FT/FR/overdue/suspension events, pairing/revocation, HMAC signing, Android SMS send, and status reflection.
- Intentional phase boundary: inbound SMS replies and cloud relay remain out of scope.
- Placeholder scan: no `TBD`/`TODO` placeholders; implementation snippets use concrete names and paths.
- Type consistency: `SmsEventType`, statuses, route paths, table names, and setting keys are consistent across tasks.
