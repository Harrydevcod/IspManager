# Qualidade de dados (Relatórios) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-quality diagnostic surface (incomplete clients + possible duplicates, with dismiss + open-client actions) inside the existing Relatórios module.

**Architecture:** Pure, unit-tested logic in `src/backend/lib/data-quality.ts`; a dedicated `GET /api/reports/data-quality` endpoint plus `POST /api/reports/data-quality/dismiss` in `reports.ts`; a new migration for the dismissals table; two new tabs in `ReportsModule` fed by the endpoint; deep-link to a client via an `onOpenClient` prop wired through `App.tsx` into `ClientsModule`.

**Tech Stack:** Fastify 5, better-sqlite3, Zod, Vitest (backend); React 19 + TypeScript (renderer). Windows: use `npm.cmd` / `npx.cmd`.

---

## File Structure

- Create `src/backend/lib/data-quality.ts` — pure helpers: `normalizePhoneKey`, `normalizeNameKey`, `computeIncompleteFlags`, `findDuplicateGroups`. Single responsibility: data-quality logic, no I/O.
- Create `src/backend/lib/data-quality.test.ts` — unit tests for the pure helpers.
- Create `src/backend/db/migrations/0013_client_duplicate_dismissals.ts` — dismissals table.
- Modify `src/backend/db/migrations/index.ts` — register `m0013`.
- Modify `src/backend/routes/reports.ts` — add the two endpoints.
- Create `src/backend/routes/data-quality.test.ts` — route tests (endpoint + dismiss).
- Modify `src/renderer/types.ts` — add `DataQualitySummary` + flag type.
- Modify `src/renderer/modules/ClientsModule.tsx` — accept `focusClientId` + `onFocusHandled`.
- Modify `src/renderer/App.tsx` — `focusClientId` state, wire `onOpenClient`.
- Modify `src/renderer/modules/ReportsModule.tsx` — two tabs, fetch, render, CSV, dismiss, `onOpenClient` prop.

**Auth note:** `requireRole(['admin','operator'])` guards both endpoints, matching `/api/reports/summary`. Route tests run with `process.env.ISPM_AUTH='off'` (existing precedent in `reports.test.ts`), so `requireRole` is a no-op there; role enforcement (403) is already covered by `auth.test.ts`. We do **not** add a 403 test here — it would require a conflicting auth-on bootstrap in the same file.

---

## Task 1: Pure normalization helpers

**Files:**
- Create: `src/backend/lib/data-quality.ts`
- Test: `src/backend/lib/data-quality.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/lib/data-quality.test.ts
import { describe, expect, test } from 'vitest';
import { normalizeNameKey, normalizePhoneKey } from './data-quality';

describe('normalizePhoneKey', () => {
  test('keeps only digits', () => {
    expect(normalizePhoneKey('991 22 33')).toBe('9912233');
  });
  test('strips the 238 country prefix', () => {
    expect(normalizePhoneKey('+238 9912233')).toBe('9912233');
  });
  test('returns null for empty input', () => {
    expect(normalizePhoneKey('')).toBeNull();
    expect(normalizePhoneKey(null)).toBeNull();
  });
});

describe('normalizeNameKey', () => {
  test('strips accents, lowercases, collapses spaces', () => {
    expect(normalizeNameKey('João  Silva')).toBe('joao silva');
  });
  test('sorts tokens so order does not matter', () => {
    expect(normalizeNameKey('Silva, João')).toBe('joao silva');
  });
  test('returns null for empty input', () => {
    expect(normalizeNameKey('   ')).toBeNull();
    expect(normalizeNameKey(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/data-quality.test.ts`
Expected: FAIL — `Cannot find module './data-quality'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/backend/lib/data-quality.ts
export function normalizePhoneKey(phone: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('238') && digits.length > 7) {
    digits = digits.slice(3);
  }
  return digits.length ? digits : null;
}

export function normalizeNameKey(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!cleaned) return null;
  return cleaned.split(' ').sort().join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/data-quality.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/data-quality.ts src/backend/lib/data-quality.test.ts
git commit -m "feat(data-quality): phone/name normalization helpers"
```

---

## Task 2: Incomplete flags + duplicate grouping

**Files:**
- Modify: `src/backend/lib/data-quality.ts`
- Test: `src/backend/lib/data-quality.test.ts`

- [ ] **Step 1: Write the failing test (append to existing test file)**

```ts
import { computeIncompleteFlags, findDuplicateGroups, type DqClient } from './data-quality';

function client(over: Partial<DqClient>): DqClient {
  return {
    id: 1, clientCode: 'CLT-0001', fullName: 'Ana Lima',
    phone: '9912233', nif: '123456789', address: 'Rua A',
    island: 'Santiago', zone: 'Praia', status: 'active',
    hasActiveService: 1, ...over
  };
}

describe('computeIncompleteFlags', () => {
  test('flags missing phone', () => {
    expect(computeIncompleteFlags(client({ phone: null }))).toContain('noPhone');
  });
  test('flags active client with no active service', () => {
    expect(computeIncompleteFlags(client({ hasActiveService: 0 }))).toContain('noActiveService');
  });
  test('does NOT flag cancelled client with no active service', () => {
    expect(computeIncompleteFlags(client({ status: 'cancelled', hasActiveService: 0 })))
      .not.toContain('noActiveService');
  });
  test('flags missing address when zone is empty', () => {
    expect(computeIncompleteFlags(client({ zone: '' }))).toContain('noAddress');
  });
  test('flags missing nif', () => {
    expect(computeIncompleteFlags(client({ nif: null }))).toContain('noNif');
  });
  test('complete client has no flags', () => {
    expect(computeIncompleteFlags(client({}))).toEqual([]);
  });
});

describe('findDuplicateGroups', () => {
  test('groups by normalized phone', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, phone: '991 22 33' }),
      client({ id: 2, fullName: 'Outro Nome', phone: '+238 9912233' })
    ], new Set());
    const phoneGroup = groups.find((g) => g.reason === 'phone');
    expect(phoneGroup?.clients.map((c) => c.id).sort()).toEqual([1, 2]);
  });
  test('groups by normalized name regardless of token order/accents', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, fullName: 'João Silva', phone: '111' }),
      client({ id: 2, fullName: 'Silva, joao', phone: '222' })
    ], new Set());
    const nameGroup = groups.find((g) => g.reason === 'name');
    expect(nameGroup?.clients.map((c) => c.id).sort()).toEqual([1, 2]);
  });
  test('excludes a dismissed pair (2-client group disappears)', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, phone: '991 22 33' }),
      client({ id: 2, fullName: 'Outro', phone: '+238 9912233' })
    ], new Set(['1-2']));
    expect(groups.find((g) => g.reason === 'phone')).toBeUndefined();
  });
  test('ignores clients with no key', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, phone: null, fullName: '' }),
      client({ id: 2, phone: null, fullName: '' })
    ], new Set());
    expect(groups).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/data-quality.test.ts`
Expected: FAIL — `computeIncompleteFlags`/`findDuplicateGroups`/`DqClient` not exported.

- [ ] **Step 3: Write minimal implementation (append to `data-quality.ts`)**

```ts
export type DqClient = {
  id: number;
  clientCode: string;
  fullName: string;
  phone: string | null;
  nif: string | null;
  address: string | null;
  island: string | null;
  zone: string | null;
  status: 'active' | 'suspended' | 'cancelled';
  hasActiveService: number;
};

export type IncompleteFlag = 'noPhone' | 'noActiveService' | 'noAddress' | 'noNif';

export function computeIncompleteFlags(client: DqClient): IncompleteFlag[] {
  const flags: IncompleteFlag[] = [];
  if (!client.phone || !client.phone.trim()) flags.push('noPhone');
  if (client.status !== 'cancelled' && !client.hasActiveService) flags.push('noActiveService');
  if (!client.address?.trim() || !client.island?.trim() || !client.zone?.trim()) flags.push('noAddress');
  if (!client.nif || !client.nif.trim()) flags.push('noNif');
  return flags;
}

export type DuplicateGroup = {
  key: string;
  reason: 'phone' | 'name';
  clients: Array<{ id: number; clientCode: string; fullName: string; phone: string | null }>;
};

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function findDuplicateGroups(clients: DqClient[], dismissedPairs: Set<string>): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  const collect = (keyFn: (c: DqClient) => string | null, reason: 'phone' | 'name') => {
    const buckets = new Map<string, DqClient[]>();
    for (const c of clients) {
      const k = keyFn(c);
      if (!k) continue;
      const list = buckets.get(k);
      if (list) list.push(c);
      else buckets.set(k, [c]);
    }
    for (const [k, members] of buckets) {
      if (members.length < 2) continue;
      const kept = members.filter((m) =>
        members.some((other) => other.id !== m.id && !dismissedPairs.has(pairKey(m.id, other.id)))
      );
      if (kept.length >= 2) {
        groups.push({
          key: `${reason}:${k}`,
          reason,
          clients: kept.map((c) => ({ id: c.id, clientCode: c.clientCode, fullName: c.fullName, phone: c.phone }))
        });
      }
    }
  };

  collect((c) => normalizePhoneKey(c.phone), 'phone');
  collect((c) => normalizeNameKey(c.fullName), 'name');
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/data-quality.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/data-quality.ts src/backend/lib/data-quality.test.ts
git commit -m "feat(data-quality): incomplete flags + duplicate grouping logic"
```

---

## Task 3: Dismissals migration

**Files:**
- Create: `src/backend/db/migrations/0013_client_duplicate_dismissals.ts`
- Modify: `src/backend/db/migrations/index.ts`

- [ ] **Step 1: Create the migration file**

```ts
// src/backend/db/migrations/0013_client_duplicate_dismissals.ts
import type { Migration } from './types';

/**
 * Pairs of clients an operator has explicitly marked as "not a duplicate".
 * The data-quality duplicate detector excludes any pair stored here.
 * Pairs are stored normalized with client_id_low < client_id_high so a pair
 * is recorded once regardless of the order it was dismissed in.
 */
const migration: Migration = {
  version: 13,
  name: 'client_duplicate_dismissals',
  sql: `
    CREATE TABLE IF NOT EXISTS client_duplicate_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id_low INTEGER NOT NULL REFERENCES clients(id),
      client_id_high INTEGER NOT NULL REFERENCES clients(id),
      dismissed_by INTEGER REFERENCES users(id),
      dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(client_id_low, client_id_high)
    );
  `
};

export default migration;
```

- [ ] **Step 2: Register it in the migrations index**

In `src/backend/db/migrations/index.ts`, add the import after the `m0012` import line:

```ts
import m0013 from './0013_client_duplicate_dismissals';
```

And append `m0013` to the exported array:

```ts
export const migrations: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013];
```

- [ ] **Step 3: Verify typecheck + migrations apply**

Run: `npx.cmd tsc -p tsconfig.json --noEmit` (or `npm.cmd run typecheck`)
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/backend/db/migrations/0013_client_duplicate_dismissals.ts src/backend/db/migrations/index.ts
git commit -m "feat(data-quality): migration for client duplicate dismissals"
```

---

## Task 4: `GET /api/reports/data-quality` endpoint

**Files:**
- Modify: `src/backend/routes/reports.ts`
- Test: `src/backend/routes/data-quality.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/routes/data-quality.test.ts
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-dq-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM client_duplicate_dismissals').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

const insertClient = (over: Record<string, unknown> = {}) => {
  const c = {
    client_code: 'CLT-0001', full_name: 'Ana Lima', phone: '9111111',
    nif: '100000001', address: 'Rua A', island: 'Santiago', zone: 'Praia',
    status: 'active', ...over
  };
  return db.prepare(`
    INSERT INTO clients (client_code, full_name, phone, nif, address, island, zone, status)
    VALUES (@client_code, @full_name, @phone, @nif, @address, @island, @zone, @status)
  `).run(c).lastInsertRowid as number;
};

describe('GET /api/reports/data-quality', () => {
  test('counts and lists incomplete clients by flag', async () => {
    insertClient({ client_code: 'CLT-0001', phone: null }); // noPhone (+ noActiveService)
    insertClient({ client_code: 'CLT-0002', full_name: 'Bruno Sa', nif: null }); // noNif (+ noActiveService)

    const res = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incompleteCounts.noPhone).toBe(1);
    expect(body.incompleteCounts.noNif).toBe(1);
    expect(body.incompleteCounts.total).toBe(2);
    expect(body.incompleteClients).toHaveLength(2);
  });

  test('filters the incomplete list by issue', async () => {
    insertClient({ client_code: 'CLT-0001', phone: null });
    insertClient({ client_code: 'CLT-0002', full_name: 'Bruno Sa', nif: null, phone: '9222222' });

    const res = await app.inject({ method: 'GET', url: '/api/reports/data-quality?issue=noPhone' });
    const body = res.json();
    expect(body.incompleteClients.every((c: { flags: string[] }) => c.flags.includes('noPhone'))).toBe(true);
    expect(body.pagination.total).toBe(1);
  });

  test('reports possible duplicates by normalized phone', async () => {
    insertClient({ client_code: 'CLT-0001', full_name: 'Ana Lima', phone: '991 22 33' });
    insertClient({ client_code: 'CLT-0002', full_name: 'Ana M Lima', phone: '+238 9912233' });

    const res = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    const body = res.json();
    const phoneGroup = body.duplicateGroups.find((g: { reason: string }) => g.reason === 'phone');
    expect(phoneGroup.clients).toHaveLength(2);
  });
});
```

> Note: `clients.phone` is `UNIQUE`, so the duplicate test uses two phones that are textually different (`991 22 33` vs `+238 9912233`) but collapse to the same normalized key — exactly the case the detector exists for.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/routes/data-quality.test.ts`
Expected: FAIL — route returns 404 / body undefined.

- [ ] **Step 3: Implement the endpoint**

In `src/backend/routes/reports.ts`, add these imports at the top (after the existing imports):

```ts
import {
  computeIncompleteFlags,
  findDuplicateGroups,
  type DqClient
} from '../lib/data-quality';
```

Add this Zod schema next to `querySchema`:

```ts
const dataQualityQuerySchema = z.object({
  issue: z.enum(['noPhone', 'noActiveService', 'noAddress', 'noNif']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});
```

Inside `registerReportRoutes`, after the existing `/api/reports/summary` handler, add:

```ts
  app.get('/api/reports/data-quality', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const parsed = dataQualityQuerySchema.safeParse(request.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Filtros invalidos' });
    }
    const { issue, page, pageSize } = parsed.data;
    const db = getSqliteDatabase();

    const rows = db.prepare(`
      SELECT
        c.id,
        c.client_code AS clientCode,
        c.full_name AS fullName,
        c.phone,
        c.nif,
        c.address,
        c.island,
        c.zone,
        c.status,
        EXISTS(SELECT 1 FROM services s WHERE s.client_id = c.id AND s.status = 'active') AS hasActiveService
      FROM clients c
    `).all() as DqClient[];

    const withFlags = rows.map((row) => ({ row, flags: computeIncompleteFlags(row) }));

    const incompleteCounts = {
      noPhone: withFlags.filter((x) => x.flags.includes('noPhone')).length,
      noActiveService: withFlags.filter((x) => x.flags.includes('noActiveService')).length,
      noAddress: withFlags.filter((x) => x.flags.includes('noAddress')).length,
      noNif: withFlags.filter((x) => x.flags.includes('noNif')).length,
      total: withFlags.filter((x) => x.flags.length > 0).length
    };

    const filtered = withFlags.filter((x) =>
      issue ? x.flags.includes(issue) : x.flags.length > 0
    );
    const total = filtered.length;
    const offset = (page - 1) * pageSize;
    const incompleteClients = filtered.slice(offset, offset + pageSize).map((x) => ({
      id: x.row.id,
      clientCode: x.row.clientCode,
      fullName: x.row.fullName,
      status: x.row.status,
      phone: x.row.phone,
      flags: x.flags
    }));

    const dismissedRows = db.prepare(`
      SELECT client_id_low AS low, client_id_high AS high FROM client_duplicate_dismissals
    `).all() as Array<{ low: number; high: number }>;
    const dismissedPairs = new Set(dismissedRows.map((d) => `${d.low}-${d.high}`));
    const duplicateGroups = findDuplicateGroups(rows, dismissedPairs);

    return {
      incompleteCounts,
      incompleteClients,
      duplicateGroups,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/routes/data-quality.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/reports.ts src/backend/routes/data-quality.test.ts
git commit -m "feat(data-quality): GET /api/reports/data-quality endpoint"
```

---

## Task 5: `POST /api/reports/data-quality/dismiss` + exclusion

**Files:**
- Modify: `src/backend/routes/reports.ts`
- Test: `src/backend/routes/data-quality.test.ts`

- [ ] **Step 1: Write the failing test (append to `data-quality.test.ts`)**

```ts
describe('POST /api/reports/data-quality/dismiss', () => {
  test('dismissing a pair removes it from duplicate detection and is idempotent', async () => {
    const a = insertClient({ client_code: 'CLT-0001', full_name: 'Ana Lima', phone: '991 22 33' });
    const b = insertClient({ client_code: 'CLT-0002', full_name: 'Ana M Lima', phone: '+238 9912233' });

    const before = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    expect(before.json().duplicateGroups.find((g: { reason: string }) => g.reason === 'phone')).toBeDefined();

    const first = await app.inject({
      method: 'POST', url: '/api/reports/data-quality/dismiss',
      payload: { clientIdA: b, clientIdB: a } // unordered on purpose
    });
    expect(first.statusCode).toBe(200);

    // idempotent: second identical dismiss does not error or duplicate the row
    const second = await app.inject({
      method: 'POST', url: '/api/reports/data-quality/dismiss',
      payload: { clientIdA: a, clientIdB: b }
    });
    expect(second.statusCode).toBe(200);
    const count = db.prepare('SELECT count(*) AS n FROM client_duplicate_dismissals').get() as { n: number };
    expect(count.n).toBe(1);

    const after = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    expect(after.json().duplicateGroups.find((g: { reason: string }) => g.reason === 'phone')).toBeUndefined();
  });

  test('rejects an invalid pair', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/reports/data-quality/dismiss',
      payload: { clientIdA: 5, clientIdB: 5 }
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/routes/data-quality.test.ts`
Expected: FAIL — dismiss route returns 404.

- [ ] **Step 3: Implement the endpoint**

In `src/backend/routes/reports.ts`, add `recordAudit` to the imports:

```ts
import { recordAudit } from '../lib/audit';
```

Add this schema near the others:

```ts
const dismissDuplicateSchema = z.object({
  clientIdA: z.coerce.number().int().positive(),
  clientIdB: z.coerce.number().int().positive()
});
```

After the `data-quality` GET handler, add:

```ts
  app.post('/api/reports/data-quality/dismiss', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
    const parsed = dismissDuplicateSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.clientIdA === parsed.data.clientIdB) {
      return reply.status(400).send({ error: 'Par invalido' });
    }
    const low = Math.min(parsed.data.clientIdA, parsed.data.clientIdB);
    const high = Math.max(parsed.data.clientIdA, parsed.data.clientIdB);
    const db = getSqliteDatabase();
    db.prepare(`
      INSERT OR IGNORE INTO client_duplicate_dismissals (client_id_low, client_id_high)
      VALUES (?, ?)
    `).run(low, high);

    recordAudit(request, {
      action: 'dismiss_duplicate',
      entityType: 'client',
      entityId: low,
      summary: `Marcou os clientes ${low} e ${high} como nao duplicados`,
      metadata: { low, high }
    });

    return reply.send({ ok: true });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/routes/data-quality.test.ts`
Expected: PASS (5 tests in file).

- [ ] **Step 5: Full backend validation + commit**

```bash
npm.cmd run typecheck
npm.cmd test
git add src/backend/routes/reports.ts src/backend/routes/data-quality.test.ts
git commit -m "feat(data-quality): dismiss endpoint excludes pairs from detection"
```

Expected: typecheck PASS; full test suite PASS.

---

## Task 6: Renderer types

**Files:**
- Modify: `src/renderer/types.ts`

- [ ] **Step 1: Add the types** (append near the existing `ReportsSummary` / `ReportView` declarations)

```ts
export type DataQualityIncompleteFlag = 'noPhone' | 'noActiveService' | 'noAddress' | 'noNif';

export type DataQualitySummary = {
  incompleteCounts: {
    noPhone: number;
    noActiveService: number;
    noAddress: number;
    noNif: number;
    total: number;
  };
  incompleteClients: Array<{
    id: number;
    clientCode: string;
    fullName: string;
    status: 'active' | 'suspended' | 'cancelled';
    phone: string | null;
    flags: DataQualityIncompleteFlag[];
  }>;
  duplicateGroups: Array<{
    key: string;
    reason: 'phone' | 'name';
    clients: Array<{ id: number; clientCode: string; fullName: string; phone: string | null }>;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};
```

- [ ] **Step 2: Verify typecheck**

Run: `npm.cmd run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/types.ts
git commit -m "feat(data-quality): renderer types for data-quality summary"
```

---

## Task 7: ClientsModule accepts focus

**Files:**
- Modify: `src/renderer/modules/ClientsModule.tsx`

- [ ] **Step 1: Change the component signature**

Replace:

```tsx
export function ClientsModule() {
```

with:

```tsx
export function ClientsModule({ focusClientId, onFocusHandled }: { focusClientId?: number | null; onFocusHandled?: () => void } = {}) {
```

- [ ] **Step 2: Add a focus effect**

Immediately after the existing state declarations (after the `useState` block, before the first `useEffect`), add:

```tsx
  useEffect(() => {
    if (!focusClientId) return;
    const existing = clients.find((c) => c.id === focusClientId);
    if (existing) {
      setSelectedClient(existing);
      onFocusHandled?.();
    }
  }, [focusClientId, clients, onFocusHandled]);
```

> Rationale: `clients` is loaded on mount; when the parent sets `focusClientId`, this opens that client's detail panel once the list is present, then calls `onFocusHandled` so the parent clears the focus (prevents re-opening after the user closes the panel).

- [ ] **Step 3: Verify typecheck**

Run: `npm.cmd run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/modules/ClientsModule.tsx
git commit -m "feat(clients): accept focusClientId to open a client from elsewhere"
```

---

## Task 8: App.tsx wiring

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add focus state**

Near the existing `const [section, setSection] = useState<SectionId>(...)` line, add:

```tsx
  const [focusClientId, setFocusClientId] = useState<number | null>(null);
```

- [ ] **Step 2: Wire ClientsModule**

Replace:

```tsx
          {section === 'clients' && <ClientsModule />}
```

with:

```tsx
          {section === 'clients' && (
            <ClientsModule focusClientId={focusClientId} onFocusHandled={() => setFocusClientId(null)} />
          )}
```

- [ ] **Step 3: Wire ReportsModule**

Replace:

```tsx
          {section === 'reports' && <ReportsModule />}
```

with:

```tsx
          {section === 'reports' && (
            <ReportsModule onOpenClient={(id) => { setFocusClientId(id); setSection('clients'); }} />
          )}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm.cmd run typecheck`
Expected: PASS only AFTER Task 9 adds the `onOpenClient` prop to `ReportsModule`. If running standalone it will error on the unknown prop — proceed to Task 9 then re-run. (Commit at the end of Task 9.)

---

## Task 9: ReportsModule — tabs, fetch, render, CSV, dismiss

**Files:**
- Modify: `src/renderer/modules/ReportsModule.tsx`

- [ ] **Step 1: Update imports and signature**

Change the type import line to also import the data-quality types:

```tsx
import type { DataQualityIncompleteFlag, DataQualitySummary, ReportsSummary, ReportView } from '../types';
```

Add `authFetch` is already imported. Add `AlertTriangle, CopyX, UserCog` to the lucide import line (extend the existing import):

```tsx
import { Activity, AlertTriangle, Banknote, Cable, CheckCircle2, CopyX, MessageCircle, UserCog, UsersRound } from 'lucide-react';
```

Change the signature:

```tsx
export function ReportsModule({ onOpenClient }: { onOpenClient?: (clientId: number) => void } = {}) {
```

- [ ] **Step 2: Add a local tab union + state**

Right after the existing `const [view, setView] = useState<ReportView>('revenue');` change it to a wider tab type. Replace that line with:

```tsx
  type Tab = ReportView | 'incomplete' | 'duplicates';
  const [view, setView] = useState<Tab>('revenue');
  const [dq, setDq] = useState<DataQualitySummary | null>(null);
  const [issue, setIssue] = useState<DataQualityIncompleteFlag | null>(null);
```

Update the `changeView` signature param type from `ReportView` to `Tab`:

```tsx
  function changeView(nextView: Tab) {
    setView(nextView);
    setPage(1);
    if (nextView !== 'incomplete') setIssue(null);
  }
```

- [ ] **Step 3: Add the data-quality fetch effect**

After the existing summary `useEffect`, add:

```tsx
  useEffect(() => {
    if (view !== 'incomplete' && view !== 'duplicates') return;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (view === 'incomplete' && issue) params.set('issue', issue);

    authFetch(`http://127.0.0.1:3001/api/reports/data-quality?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error('Nao foi possivel carregar qualidade de dados');
        return response.json() as Promise<DataQualitySummary>;
      })
      .then((data) => { setDq(data); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Erro ao carregar qualidade de dados'));
  }, [view, issue, page]);
```

- [ ] **Step 4: Add the dismiss handler**

After `sendOverdueWhatsapp`, add:

```tsx
  async function dismissDuplicate(clientIdA: number, clientIdB: number) {
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/reports/data-quality/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientIdA, clientIdB })
      });
      if (!response.ok) throw new Error('Nao foi possivel dispensar o par');
      // refetch current view
      setDq(null);
      setView((v) => v); // no-op to keep type; trigger refetch via page bump
      setPage((p) => p);
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const refetch = await authFetch(`http://127.0.0.1:3001/api/reports/data-quality?${params.toString()}`);
      if (refetch.ok) setDq(await refetch.json() as DataQualitySummary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao dispensar duplicado');
    }
  }
```

> Note: duplicates view is not date-filtered and ignores `issue`, so a direct refetch is simplest.

- [ ] **Step 5: Extend `exportCsv` for the new views**

Inside `exportCsv`, replace the `const rows = ...` assignment with a version that handles the two new views. Add these branches by changing the ternary into an explicit block:

```tsx
    let rows: Array<Array<string | number>>;
    if (view === 'revenue') {
      rows = [
        ['Mes', 'Pago CVE', 'Pendente CVE', 'Cobrancas'],
        ...summary.revenueByMonth.map((row) => [row.referenceMonth, row.paidCve, row.pendingCve, row.payments])
      ];
    } else if (view === 'overdue') {
      rows = [
        ['Cliente', 'Codigo', 'Telefone', 'Cobrancas', 'Valor CVE', 'Vencimento mais antigo'],
        ...summary.overdueClients.map((row) => [row.clientName, row.clientCode, row.phone || '', row.payments, row.amountCve, row.oldestDueDate])
      ];
    } else if (view === 'stock') {
      rows = [
        ['Tipo', 'Marca', 'Modelo', 'Stock', 'Valor CVE'],
        ...summary.stockRows.map((row) => [row.type, row.brand, row.model, row.stockTotal, row.valueCve])
      ];
    } else if (view === 'incomplete') {
      rows = [
        ['Codigo', 'Cliente', 'Estado', 'Telefone', 'Lacunas'],
        ...(dq?.incompleteClients ?? []).map((row) => [row.clientCode, row.fullName, row.status, row.phone || '', row.flags.join(' | ')])
      ];
    } else {
      rows = [
        ['Razao', 'Codigo', 'Cliente', 'Telefone'],
        ...(dq?.duplicateGroups ?? []).flatMap((g) => g.clients.map((c) => [g.reason, c.clientCode, c.fullName, c.phone || '']))
      ];
    }
```

Also change the guard at the top of `exportCsv` so the data-quality views can export even when `summary` is null:

```tsx
    if ((view === 'incomplete' || view === 'duplicates') ? !dq : !summary) {
      return;
    }
```

- [ ] **Step 6: Add the tab buttons**

In the `.report-tabs` block, add two buttons before the "Exportar CSV" button:

```tsx
          <Button variant="ghost" size="sm" className={view === 'incomplete' ? 'active' : ''} onClick={() => changeView('incomplete')}>Incompletos</Button>
          <Button variant="ghost" size="sm" className={view === 'duplicates' ? 'active' : ''} onClick={() => changeView('duplicates')}>Duplicados</Button>
```

- [ ] **Step 7: Render the two new views**

Inside the `.module-table` div, after the `view === 'stock'` map block (and its EmptyState), add the incomplete + duplicates rendering:

```tsx
        {view === 'incomplete' && (
          <div className="inline-actions dq-issue-filter">
            <Button variant="ghost" size="sm" className={issue === null ? 'active' : ''} onClick={() => { setIssue(null); setPage(1); }}>Todos {dq ? `(${dq.incompleteCounts.total})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noPhone' ? 'active' : ''} onClick={() => { setIssue('noPhone'); setPage(1); }}>Sem telefone {dq ? `(${dq.incompleteCounts.noPhone})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noActiveService' ? 'active' : ''} onClick={() => { setIssue('noActiveService'); setPage(1); }}>Sem servico {dq ? `(${dq.incompleteCounts.noActiveService})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noAddress' ? 'active' : ''} onClick={() => { setIssue('noAddress'); setPage(1); }}>Sem morada {dq ? `(${dq.incompleteCounts.noAddress})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noNif' ? 'active' : ''} onClick={() => { setIssue('noNif'); setPage(1); }}>Sem NIF {dq ? `(${dq.incompleteCounts.noNif})` : ''}</Button>
          </div>
        )}
        {view === 'incomplete' && dq?.incompleteClients.map((row) => (
          <button type="button" className="module-row report-row with-action dq-row" key={row.id} onClick={() => onOpenClient?.(row.id)}>
            <span>
              <small className="entity-code">{row.clientCode}</small>
              <strong>{row.fullName}</strong>
              <small>{row.phone || 'sem telefone'}</small>
            </span>
            <span className="dq-flags">
              {row.flags.map((flag) => (
                <span className="badge badge-warn" key={flag}>
                  {flag === 'noPhone' ? 'telefone' : flag === 'noActiveService' ? 'servico' : flag === 'noAddress' ? 'morada' : 'NIF'}
                </span>
              ))}
            </span>
            <UserCog size={16} aria-hidden />
          </button>
        ))}
        {view === 'duplicates' && dq?.duplicateGroups.map((group) => (
          <div className="module-row report-row dq-group" key={group.key}>
            <span className="dq-group-reason">
              <AlertTriangle size={16} aria-hidden />
              <small>{group.reason === 'phone' ? 'Telefone igual' : 'Nome parecido'}</small>
            </span>
            <span className="dq-group-clients">
              {group.clients.map((c) => (
                <Button key={c.id} variant="ghost" size="sm" onClick={() => onOpenClient?.(c.id)}>
                  {c.clientCode} · {c.fullName}
                </Button>
              ))}
            </span>
            {group.clients.length === 2 && (
              <Button variant="ghost" size="sm" leadingIcon={<CopyX size={16} />} onClick={() => void dismissDuplicate(group.clients[0].id, group.clients[1].id)}>
                Nao e duplicado
              </Button>
            )}
          </div>
        ))}
        {view === 'incomplete' && dq && dq.incompleteClients.length === 0 && (
          <EmptyState icon={CheckCircle2} title="Sem dados incompletos" description="Todos os clientes têm os campos essenciais preenchidos." />
        )}
        {view === 'duplicates' && dq && dq.duplicateGroups.length === 0 && (
          <EmptyState icon={CheckCircle2} title="Sem duplicados" description="Não foram encontrados clientes com telefone ou nome repetidos." />
        )}
```

- [ ] **Step 8: Fix pagination for the new views**

The pagination block uses `summary && total > PAGE_SIZE`. Generalize so it also covers data-quality views. Replace the pagination wrapper condition:

```tsx
        {((view === 'incomplete' && dq) || (view !== 'incomplete' && view !== 'duplicates' && summary)) && (view === 'incomplete' ? (dq!.pagination.total) : total) > PAGE_SIZE && (
```

and inside it, compute the page count from the right source by replacing `totalPages` usages in that block with:

```tsx
              {/* page label */}
              <span>Pagina {page} de {view === 'incomplete' ? dq!.pagination.totalPages : totalPages}</span>
```

and the "Proxima" disabled check:

```tsx
              disabled={page >= (view === 'incomplete' ? dq!.pagination.totalPages : totalPages)}
```

(Duplicates view returns all groups unpaginated, so it intentionally has no pager.)

- [ ] **Step 9: Hide the date filter bar for data-quality views**

Wrap the `<FilterBar ...>` so it only shows for the date-driven views. Change the `disabled={view === 'stock'}` props is not enough — for clarity, render the FilterBar conditionally:

```tsx
      {view !== 'incomplete' && view !== 'duplicates' && (
        <FilterBar className="reports-filter-bar">
          {/* ...existing date fields unchanged... */}
        </FilterBar>
      )}
```

- [ ] **Step 10: Verify typecheck**

Run: `npm.cmd run typecheck`
Expected: PASS (Task 8 + Task 9 together resolve the `onOpenClient` prop).

- [ ] **Step 11: Add minimal styles**

Find the stylesheet that defines `.report-row` (search: `git grep -n "report-row" src/renderer`). In that file, append:

```css
.dq-row { width: 100%; text-align: left; background: none; border: inherit; cursor: pointer; }
.dq-flags { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.badge-warn { background: var(--accent-2-soft, rgba(245, 158, 11, 0.15)); color: var(--accent-2, #f59e0b); border-radius: 6px; padding: 2px 6px; font-size: 11px; }
.dq-issue-filter { flex-wrap: wrap; margin-bottom: 8px; }
.dq-group-reason { display: inline-flex; align-items: center; gap: 6px; }
.dq-group-clients { display: inline-flex; gap: 6px; flex-wrap: wrap; }
```

> Use existing tokens if the audited token names differ — check the file's `:root` for the accent/warn token before hardcoding. Match the surrounding badge styles already used by status badges.

- [ ] **Step 12: Full validation**

```bash
npm.cmd run typecheck
npm.cmd test
npx.cmd tsc -p tsconfig.main.json
```

Expected: all PASS.

- [ ] **Step 13: Commit**

```bash
git add src/renderer/App.tsx src/renderer/modules/ClientsModule.tsx src/renderer/modules/ReportsModule.tsx
git commit -m "feat(reports): data-quality tabs (incompletos + duplicados) with open-client + dismiss"
```

---

## Task 10: Manual smoke + docs

**Files:**
- Modify: `.specs/project/STATE.md`

- [ ] **Step 1: Manual smoke (Electron/dev)**

Per project memory, automated build is blocked by `node-gyp`; do a dev smoke instead:
- `npm.cmd run dev`, open Relatórios.
- Confirm the two new tabs load, the issue filters work, clicking an incomplete row opens the client detail in Clientes, "Não é duplicado" makes a 2-client group disappear after refetch.

- [ ] **Step 2: Update STATE.md**

Add a bullet under "Completed In This Session" summarizing the data-quality feature, and refresh "Next Candidates".

- [ ] **Step 3: Commit**

```bash
git add .specs/project/STATE.md
git commit -m "docs(state): record data-quality reports feature"
```

---

## Self-Review Notes

- **Spec coverage:** Incompletos (Task 4) ✓; 4 flags incl. cancelled-exclusion (Task 2) ✓; duplicates phone+name (Task 2/4) ✓; dismiss + exclusion (Task 3/5) ✓; open-client navigation (Task 7/8/9) ✓; CSV export both views (Task 9) ✓; migration 0013 (Task 3) ✓; Vitest coverage (Tasks 1,2,4,5) ✓.
- **Auth/403:** intentionally delegated to `auth.test.ts` (documented above) because the route-test bootstrap runs `ISPM_AUTH='off'`.
- **Type consistency:** `DataQualitySummary` shape in `types.ts` (Task 6) matches the endpoint response (Task 4) and `findDuplicateGroups`/`computeIncompleteFlags` outputs (Task 2). `DqClient` reused from lib in the route.
- **Near-match (Levenshtein):** out of scope per spec; normalized-equality only.
