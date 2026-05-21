# Backup automático + Restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consistent automatic SQLite backups on startup with daily/weekly retention, plus a fail-safe restore that swaps the DB file and relaunches the app.

**Architecture:** A pure retention selector + an IO backup engine in `src/backend/lib/backup.ts` (using `better-sqlite3` `db.backup()` for online consistent copies), exposed via `src/backend/routes/backup.ts`, triggered once per boot from `createBackendApp()`, with restore delegating the Electron relaunch through a new `app:relaunch` IPC bridge. The data-dir resolution duplicated today is extracted to `src/backend/lib/paths.ts`.

**Tech Stack:** TypeScript, better-sqlite3, Fastify 5, Vitest, Electron 42.

**Repo note:** This project is **not** under git (`Is a git repository: false`). Every "Checkpoint" step replaces a commit: run the validation commands and confirm green before proceeding. Windows shell — use `npm.cmd` / `npx.cmd`.

**Spec:** `docs/superpowers/specs/2026-05-15-backup-restore-design.md`. Related: `docs/adr/0003-versioned-sql-migrations.md`.

---

## File Structure

- Create `src/backend/lib/paths.ts` — `resolveDataDir()`, single source of the data directory path.
- Modify `src/backend/db/database.ts` — consume `resolveDataDir()`; add production `closeDatabase()`; `closeDatabaseForTests()` delegates.
- Create `src/backend/lib/backup.ts` — types, `resolveBackupDir`, `selectForRetention` (pure), `listBackups`, `createBackup`, `pruneBackups`, `validateBackup`, `restoreBackup`.
- Create `src/backend/lib/backup.test.ts` — unit tests for the engine.
- Create `src/backend/routes/backup.ts` — `GET/POST /api/backups`, `POST /api/backups/restore`.
- Create `src/backend/routes/backup.test.ts` — route tests via `app.inject()`.
- Modify `src/backend/server.ts` — auto-backup after `getDatabase()`; register backup routes.
- Modify `src/backend/routes/settings.ts` — accept/validate `backupDir`.
- Modify `src/main/preload.ts` + `src/main/index.ts` — `app:relaunch` IPC.
- Modify `src/renderer/App.tsx` + `src/renderer/styles.css` — "Backups" panel in Definições.

---

## Task 1: Extract `resolveDataDir()` and add `closeDatabase()`

**Files:**
- Create: `src/backend/lib/paths.ts`
- Create: `src/backend/lib/paths.test.ts`
- Modify: `src/backend/db/database.ts`

- [ ] **Step 1: Write the failing test**

`src/backend/lib/paths.test.ts`:
```ts
import { afterEach, describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from './paths';

const original = process.env.ISPM_DATA_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.ISPM_DATA_DIR;
  else process.env.ISPM_DATA_DIR = original;
});

describe('resolveDataDir', () => {
  test('honours ISPM_DATA_DIR when set', () => {
    process.env.ISPM_DATA_DIR = path.join(os.tmpdir(), 'ispm-x');
    expect(resolveDataDir()).toBe(path.join(os.tmpdir(), 'ispm-x'));
  });

  test('falls back to an ISPM folder under APPDATA or home', () => {
    delete process.env.ISPM_DATA_DIR;
    const dir = resolveDataDir();
    expect(path.basename(dir)).toBe('ISPM');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/paths.test.ts`
Expected: FAIL — `Failed to load url ./paths` (file missing).

- [ ] **Step 3: Write minimal implementation**

`src/backend/lib/paths.ts`:
```ts
import os from 'node:os';
import path from 'node:path';

/** Single source of the on-disk data directory. Mirrors the historical
 *  inline logic from database.ts so backups and the DB never disagree. */
export function resolveDataDir(): string {
  return (
    process.env.ISPM_DATA_DIR
    || path.join(process.env.APPDATA || os.homedir(), 'ISPM')
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/paths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `database.ts` to use it and add `closeDatabase()`**

In `src/backend/db/database.ts`:

Add after `import path from 'node:path';`:
```ts
import { resolveDataDir } from '../lib/paths';
```
Remove `import os from 'node:os';` (only used for the data dir).

Replace:
```ts
  const dataDir = process.env.ISPM_DATA_DIR
    || path.join(process.env.APPDATA || os.homedir(), 'ISPM');
```
with:
```ts
  const dataDir = resolveDataDir();
```

Replace:
```ts
export function closeDatabaseForTests() {
  sqliteInstance?.close();
  sqliteInstance = null;
  database = null;
}
```
with:
```ts
/** Closes the live SQLite connection. Used by restore before swapping the
 *  file, and by tests. After this, getDatabase() reopens + re-migrates. */
export function closeDatabase() {
  sqliteInstance?.close();
  sqliteInstance = null;
  database = null;
}

export function closeDatabaseForTests() {
  closeDatabase();
}
```

- [ ] **Step 6: Checkpoint**

Run: `npm.cmd run typecheck` then `npm.cmd test` then `npx.cmd tsc -p tsconfig.main.json`
Expected: typecheck clean; all tests pass (paths + existing 23); main tsc no output.

---

## Task 2: `selectForRetention` (pure) + backup types

**Files:**
- Create: `src/backend/lib/backup.ts` (types + `selectForRetention` only this task)
- Create: `src/backend/lib/backup.test.ts`

- [ ] **Step 1: Write the failing test**

`src/backend/lib/backup.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { selectForRetention, type BackupEntry } from './backup';

function entry(iso: string): BackupEntry {
  return { file: `ispm-${iso}.sqlite`, createdAt: new Date(iso), sizeBytes: 1 };
}

describe('selectForRetention', () => {
  const now = new Date('2026-05-15T12:00:00');

  test('keeps the most recent entry per day within the 14-day window', () => {
    const sameDay = [
      entry('2026-05-15T08:00:00'),
      entry('2026-05-15T09:00:00'),
      entry('2026-05-15T10:00:00'),
    ];
    const toDelete = selectForRetention(sameDay, now);
    expect(toDelete.map((e) => e.createdAt.getHours()).sort()).toEqual([8, 9]);
  });

  test('keeps one per ISO week for entries older than the daily window', () => {
    const older = [
      entry('2026-04-06T10:00:00'),
      entry('2026-04-08T10:00:00'),
    ];
    const toDelete = selectForRetention(older, now);
    expect(toDelete).toHaveLength(1);
    expect(toDelete[0].createdAt.getDate()).toBe(6);
  });

  test('prunes weeklies beyond 8 weeks past the daily window', () => {
    const entries: BackupEntry[] = [];
    for (let w = 1; w <= 12; w++) {
      const d = new Date(now);
      d.setDate(d.getDate() - 14 - w * 7);
      entries.push({ file: `ispm-w${w}.sqlite`, createdAt: d, sizeBytes: 1 });
    }
    const kept = entries.length - selectForRetention(entries, now).length;
    expect(kept).toBe(8);
  });

  test('never selects pre-restore snapshots', () => {
    const pre: BackupEntry = {
      file: 'pre-restore-20240101-000000.sqlite',
      createdAt: new Date('2024-01-01T00:00:00'),
      sizeBytes: 1,
    };
    expect(selectForRetention([pre], now)).toEqual([]);
  });

  test('empty input yields empty deletion list', () => {
    expect(selectForRetention([], now)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/backup.test.ts`
Expected: FAIL — `Failed to load url ./backup`.

- [ ] **Step 3: Write minimal implementation**

`src/backend/lib/backup.ts`:
```ts
export interface BackupEntry {
  /** Filename only (not a full path). */
  file: string;
  createdAt: Date;
  sizeBytes: number;
}

const DAILY_WINDOW_DAYS = 14;
const WEEKLY_WINDOW_WEEKS = 8;

function isPreRestore(file: string): boolean {
  return file.startsWith('pre-restore-');
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/** Returns the entries that should be DELETED. Pure: no filesystem access.
 *  Keeps the newest entry per calendar day within the last 14 days; from
 *  entries older than that window, keeps the newest per ISO week for up to
 *  8 weeks; prunes everything else. pre-restore-* snapshots are never
 *  selected (disaster-recovery evidence, rare). */
export function selectForRetention(entries: BackupEntry[], now: Date): BackupEntry[] {
  const managed = entries.filter((e) => !isPreRestore(e.file));
  const sorted = [...managed].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  const dailyCutoff = new Date(now);
  dailyCutoff.setDate(dailyCutoff.getDate() - DAILY_WINDOW_DAYS);

  const keep = new Set<BackupEntry>();
  const seenDay = new Set<string>();
  const weekly: BackupEntry[] = [];

  for (const e of sorted) {
    if (e.createdAt.getTime() >= dailyCutoff.getTime()) {
      const k = dayKey(e.createdAt);
      if (!seenDay.has(k)) {
        seenDay.add(k);
        keep.add(e);
      }
    } else {
      weekly.push(e);
    }
  }

  const seenWeek = new Set<string>();
  for (const e of weekly) {
    const k = isoWeekKey(e.createdAt);
    if (!seenWeek.has(k) && seenWeek.size < WEEKLY_WINDOW_WEEKS) {
      seenWeek.add(k);
      keep.add(e);
    }
  }

  return managed.filter((e) => !keep.has(e));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/backup.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Checkpoint**

Run: `npm.cmd run typecheck` then `npm.cmd test`
Expected: clean; all tests pass.

---

## Task 3: `resolveBackupDir`, `createBackup`, `listBackups`, `pruneBackups`, `validateBackup`

**Files:**
- Modify: `src/backend/lib/backup.ts`
- Modify: `src/backend/lib/backup.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/backend/lib/backup.test.ts`:
```ts
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createBackup,
  listBackups,
  pruneBackups,
  validateBackup,
} from './backup';
import { runMigrations } from '../db/migrate';

describe('backup engine IO', () => {
  let dir: string;

  function setData(): string {
    dir = mkdtempSync(path.join(tmpdir(), 'ispm-bk-'));
    process.env.ISPM_DATA_DIR = dir;
    const db = new Database(path.join(dir, 'ispm.sqlite'));
    runMigrations(db);
    db.close();
    return dir;
  }

  test('createBackup produces a valid migrated copy', async () => {
    setData();
    const e = await createBackup('manual');
    const full = path.join(dir, 'backups', e.file);
    expect(existsSync(full)).toBe(true);
    expect(validateBackup(full).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('validateBackup rejects a corrupt file', () => {
    setData();
    const bad = path.join(dir, 'bad.sqlite');
    writeFileSync(bad, 'not a database');
    expect(validateBackup(bad).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('validateBackup rejects a pre-migrations database', () => {
    setData();
    const plain = path.join(dir, 'plain.sqlite');
    const d = new Database(plain);
    d.exec('CREATE TABLE x (a TEXT);');
    d.close();
    expect(validateBackup(plain).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('listBackups + pruneBackups apply retention', async () => {
    setData();
    await createBackup('manual');
    await createBackup('manual');
    expect(listBackups().length).toBeGreaterThanOrEqual(1);
    expect(() => pruneBackups()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/backup.test.ts`
Expected: FAIL — `createBackup` / `validateBackup` not exported.

- [ ] **Step 3: Implement**

Append to `src/backend/lib/backup.ts`:
```ts
import Database from 'better-sqlite3';
import {
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { getSqliteDatabase } from '../db/database';
import { resolveDataDir } from './paths';

const FILE_RE = /^(?:ispm|pre-restore)-(\d{8})-(\d{6})\.sqlite$/;

function settingsBackupDir(): string | null {
  const db = getSqliteDatabase();
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get('backupDir') as { value: string } | undefined;
  const raw = row?.value?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function resolveBackupDir(): string {
  const configured = settingsBackupDir();
  const dir = configured || path.join(resolveDataDir(), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function parseStamp(file: string): Date | null {
  const m = FILE_RE.exec(file);
  if (!m) return null;
  const [, d, t] = m;
  return new Date(
    Number(d.slice(0, 4)),
    Number(d.slice(4, 6)) - 1,
    Number(d.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    Number(t.slice(4, 6)),
  );
}

export async function createBackup(
  reason: 'startup' | 'manual',
): Promise<BackupEntry> {
  void reason; // kept for future audit-log divergence; retention is uniform
  const dir = resolveBackupDir();
  const now = new Date();
  const file = `ispm-${stamp(now)}.sqlite`;
  const dest = path.join(dir, file);
  await getSqliteDatabase().backup(dest);
  return { file, createdAt: now, sizeBytes: statSync(dest).size };
}

export function listBackups(): BackupEntry[] {
  const dir = resolveBackupDir();
  return readdirSync(dir)
    .map((file) => {
      const createdAt = parseStamp(file);
      if (!createdAt) return null;
      return {
        file,
        createdAt,
        sizeBytes: statSync(path.join(dir, file)).size,
      } as BackupEntry;
    })
    .filter((e): e is BackupEntry => e !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function pruneBackups(): void {
  const dir = resolveBackupDir();
  for (const e of selectForRetention(listBackups(), new Date())) {
    rmSync(path.join(dir, e.file), { force: true });
  }
}

export function validateBackup(file: string): { ok: boolean; reason?: string } {
  if (!existsSync(file)) return { ok: false, reason: 'Ficheiro inexistente' };
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      return { ok: false, reason: 'Integridade do ficheiro falhou' };
    }
    const migrated = db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'`,
      )
      .get();
    if (!migrated) {
      return { ok: false, reason: 'Backup sem schema_migrations' };
    }
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    if (n.n < 1) {
      return { ok: false, reason: 'schema_migrations vazio' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    db?.close();
  }
}
```
Keep the Task-2 `BackupEntry`/`selectForRetention` above these additions.

- [ ] **Step 4: Run to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/backup.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Checkpoint**

Run: `npm.cmd run typecheck` then `npm.cmd test` then `npx.cmd tsc -p tsconfig.main.json`
Expected: all green.

---

## Task 4: `restoreBackup`

**Files:**
- Modify: `src/backend/lib/backup.ts`
- Modify: `src/backend/lib/backup.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/backend/lib/backup.test.ts`:
```ts
import { restoreBackup } from './backup';
import { getSqliteDatabase, closeDatabase } from '../db/database';

describe('restoreBackup', () => {
  test('rejects an invalid file without mutating state', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ispm-rs-'));
    process.env.ISPM_DATA_DIR = dir;
    const live = new Database(path.join(dir, 'ispm.sqlite'));
    runMigrations(live);
    live.close();

    const bad = path.join(dir, 'bad.sqlite');
    writeFileSync(bad, 'garbage');
    expect(() => restoreBackup(bad)).toThrow();
    const snaps = readdirSync(path.join(dir, 'backups')).filter((f) =>
      f.startsWith('pre-restore-'),
    );
    expect(snaps).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('valid restore snapshots current DB and swaps the file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ispm-rs2-'));
    process.env.ISPM_DATA_DIR = dir;
    const db = getSqliteDatabase();
    db.prepare(
      `INSERT INTO clients (client_code, full_name) VALUES (?, ?)`,
    ).run('LIVE-1', 'Live Row');
    closeDatabase();

    const fresh = new Database(path.join(dir, 'tmpsrc.sqlite'));
    runMigrations(fresh);
    fresh.close();
    const bdir = path.join(dir, 'backups');
    mkdirSync(bdir, { recursive: true });
    const backupFile = path.join(bdir, 'ispm-20260101-000000.sqlite');
    copyFileSync(path.join(dir, 'tmpsrc.sqlite'), backupFile);

    const res = restoreBackup(backupFile);
    expect(res.restartRequired).toBe(true);
    const snaps = readdirSync(bdir).filter((f) => f.startsWith('pre-restore-'));
    expect(snaps.length).toBeGreaterThanOrEqual(1);

    const reopened = getSqliteDatabase();
    const live = reopened
      .prepare('SELECT 1 FROM clients WHERE client_code = ?')
      .get('LIVE-1');
    expect(live).toBeUndefined();
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/backup.test.ts`
Expected: FAIL — `restoreBackup` not exported.

- [ ] **Step 3: Implement**

Update the Task-3 import line `import { getSqliteDatabase } from '../db/database';` to:
```ts
import { getSqliteDatabase, closeDatabase } from '../db/database';
```
Append to `src/backend/lib/backup.ts`:
```ts
/** Validates `file`, snapshots the current live DB to a pre-restore-*
 *  safety copy, closes the connection, and swaps the SQLite file. The
 *  caller must relaunch the app; on next boot getDatabase() reopens and
 *  re-migrates the restored file forward. */
export function restoreBackup(file: string): { restartRequired: true } {
  const check = validateBackup(file);
  if (!check.ok) {
    throw new Error(`Backup inválido: ${check.reason}`);
  }

  const dataDir = resolveDataDir();
  const livePath = path.join(dataDir, 'ispm.sqlite');
  const backupDir = resolveBackupDir();

  if (existsSync(livePath)) {
    const snap = path.join(backupDir, `pre-restore-${stamp(new Date())}.sqlite`);
    copyFileSync(livePath, snap);
  }

  closeDatabase();

  copyFileSync(file, livePath);
  for (const side of ['-wal', '-shm']) {
    const p = `${livePath}${side}`;
    if (existsSync(p)) rmSync(p, { force: true });
  }

  return { restartRequired: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx.cmd vitest run src/backend/lib/backup.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Checkpoint**

Run: `npm.cmd run typecheck` then `npm.cmd test` then `npx.cmd tsc -p tsconfig.main.json`
Expected: all green.

---

## Task 5: Routes + server wiring + startup auto-backup

**Files:**
- Create: `src/backend/routes/backup.ts`
- Create: `src/backend/routes/backup.test.ts`
- Modify: `src/backend/server.ts`

- [ ] **Step 1: Write the failing route test**

`src/backend/routes/backup.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-bkroute-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const server = await import('../server');
  app = await server.createBackendApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('backup routes', () => {
  test('GET /api/backups lists at least the startup backup', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backups' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.backupDir).toBe('string');
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/backups creates a new backup', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/backups' })).json();
    const res = await app.inject({ method: 'POST', url: '/api/backups' });
    expect(res.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/backups' })).json();
    expect(after.entries.length).toBeGreaterThanOrEqual(before.entries.length);
  });

  test('POST /api/backups/restore rejects path traversal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      payload: { file: '../../etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/backups/restore returns restartRequired for a real backup', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/backups' })).json();
    const file = list.entries[0].file as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      payload: { file },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().restartRequired).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx.cmd vitest run src/backend/routes/backup.test.ts`
Expected: FAIL — 404 on `/api/backups`.

- [ ] **Step 3: Implement the routes**

`src/backend/routes/backup.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import {
  createBackup,
  listBackups,
  pruneBackups,
  resolveBackupDir,
  restoreBackup,
} from '../lib/backup';

const restoreSchema = z.object({ file: z.string().trim().min(1) });

export async function registerBackupRoutes(app: FastifyInstance) {
  app.get('/api/backups', async () => {
    return { backupDir: resolveBackupDir(), entries: listBackups() };
  });

  app.post('/api/backups', async () => {
    const entry = await createBackup('manual');
    pruneBackups();
    return entry;
  });

  app.post('/api/backups/restore', async (request, reply) => {
    const parsed = restoreSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Pedido inválido' });
    }
    const name = parsed.data.file;
    if (name !== path.basename(name)) {
      return reply.status(400).send({ error: 'Nome de ficheiro inválido' });
    }
    const full = path.join(resolveBackupDir(), name);
    try {
      return restoreBackup(full);
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
  });
}
```

- [ ] **Step 4: Wire into `server.ts`**

In `src/backend/server.ts`, add with the other route imports:
```ts
import { registerBackupRoutes } from './routes/backup';
import { createBackup, pruneBackups } from './lib/backup';
```

Replace:
```ts
  getDatabase();
  await registerHealthRoutes(app);
```
with:
```ts
  getDatabase();

  // One consistent backup per boot. Availability > backup: never block the
  // app if the backup directory is unwritable. See spec.
  try {
    await createBackup('startup');
    pruneBackups();
  } catch (err) {
    app.log.error({ err }, 'startup backup failed');
  }

  await registerHealthRoutes(app);
```

Add after `await registerSettingsRoutes(app);`:
```ts
  await registerBackupRoutes(app);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx.cmd vitest run src/backend/routes/backup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Checkpoint**

Run: `npm.cmd run typecheck` then `npm.cmd test` then `npx.cmd tsc -p tsconfig.main.json`
Expected: all green.

---

## Task 6: `backupDir` setting + writable validation

**Files:**
- Modify: `src/backend/routes/settings.ts`
- Modify: `src/backend/routes/finance.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('finance routes')` block in `src/backend/routes/finance.test.ts`:
```ts
test('settings PUT rejects a non-existent backupDir', async () => {
  const base = {
    companyName: 'X', defaultDueDay: 1, currencyCode: 'CVE',
    invoicePrefix: 'FT', receiptPrefix: 'RC',
  };
  const res = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { ...base, backupDir: 'Z:\\nope\\does\\not\\exist' },
  });
  expect(res.statusCode).toBe(400);
});

test('settings PUT accepts an empty backupDir (use default)', async () => {
  const base = {
    companyName: 'X', defaultDueDay: 1, currencyCode: 'CVE',
    invoicePrefix: 'FT', receiptPrefix: 'RC',
  };
  const res = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { ...base, backupDir: '' },
  });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx.cmd vitest run src/backend/routes/finance.test.ts`
Expected: FAIL — non-existent backupDir not rejected.

- [ ] **Step 3: Implement**

In `src/backend/routes/settings.ts`:

Add to `settingsSchema` after `receiptPrefix`:
```ts
  backupDir: z.string().trim().max(500).optional().nullable(),
```
Add to `defaultSettings`:
```ts
  backupDir: '',
```
Add import at top:
```ts
import { existsSync, statSync, accessSync, constants } from 'node:fs';
```
In the PUT handler, after the receipt-prefix check and before building `save`:
```ts
    const wantedBackupDir = (parsed.data.backupDir ?? '').trim();
    if (wantedBackupDir.length > 0) {
      try {
        if (!existsSync(wantedBackupDir) || !statSync(wantedBackupDir).isDirectory()) {
          return reply.status(400).send({ error: 'Pasta de backups inexistente' });
        }
        accessSync(wantedBackupDir, constants.W_OK);
      } catch {
        return reply.status(400).send({ error: 'Pasta de backups sem permissão de escrita' });
      }
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx.cmd vitest run src/backend/routes/finance.test.ts`
Expected: PASS (all finance tests incl. the 2 new).

- [ ] **Step 5: Checkpoint**

Run: `npm.cmd run typecheck` then `npm.cmd test` then `npx.cmd tsc -p tsconfig.main.json`
Expected: all green.

---

## Task 7: Electron `app:relaunch` IPC (with dev graceful degradation)

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/main/index.ts`

No automated test (Electron main is not under Vitest). Verified by `tsc -p tsconfig.main.json` + manual.

- [ ] **Step 1: Extend the preload bridge**

Replace `src/main/preload.ts` entirely:
```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ispm', {
  platform: process.platform,
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
});
```

- [ ] **Step 2: Handle the IPC in main**

In `src/main/index.ts`, change the electron import:
```ts
import { app, BrowserWindow, ipcMain } from 'electron';
```
Inside `app.whenReady().then(async () => { ... })`, before `await createWindow();`:
```ts
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
```

- [ ] **Step 3: Checkpoint**

Run: `npx.cmd tsc -p tsconfig.main.json`
Expected: no output. Note: dev mode does not inject preload (`preload: isDevelopment ? undefined`), so `window.ispm.relaunch` is undefined in dev — the renderer (Task 8) degrades gracefully ("feche e reabra").

---

## Task 8: Renderer — "Backups" panel in Definições

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

No UI test harness (per spec — manual smoke + `tsc`). Follow the existing `selected*`/sub-panel idiom; no modal abstraction.

- [ ] **Step 1: Add the typed bridge declaration**

Near the top of `src/renderer/App.tsx`, after the imports:
```ts
declare global {
  interface Window {
    ispm?: { platform: string; relaunch?: () => Promise<void> };
  }
}
```
Ensure `useEffect` is in the existing `import { ... } from 'react'` line.

- [ ] **Step 2: Add the Backups sub-component**

Add at top level near other module components (e.g. after `PaymentsModule`):
```tsx
type BackupItem = { file: string; createdAt: string; sizeBytes: number };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function BackupsPanel() {
  const [entries, setEntries] = useState<BackupItem[]>([]);
  const [backupDir, setBackupDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmFile, setConfirmFile] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  async function load() {
    const res = await fetch('http://127.0.0.1:3001/api/backups');
    const data = await res.json();
    setEntries(data.entries);
    setBackupDir(data.backupDir);
  }

  useEffect(() => { void load(); }, []);

  async function createNow() {
    setBusy(true);
    setMessage('');
    try {
      await fetch('http://127.0.0.1:3001/api/backups', { method: 'POST' });
      await load();
      setMessage('Backup criado.');
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(file: string) {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch('http://127.0.0.1:3001/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) {
        const e = await res.json();
        setMessage(`Erro: ${e.error}`);
        return;
      }
      if (window.ispm?.relaunch) {
        await window.ispm.relaunch();
      } else {
        setMessage('Restauro concluído. Feche e reabra a aplicação para carregar os dados restaurados.');
      }
    } finally {
      setBusy(false);
      setConfirmFile(null);
      setConfirmText('');
    }
  }

  return (
    <section className="backups-panel">
      <header className="backups-head">
        <div>
          <h3>Backups</h3>
          <p className="backups-dir">{backupDir}</p>
        </div>
        <button disabled={busy} onClick={() => void createNow()}>
          Criar backup agora
        </button>
      </header>

      {message && <p className="backups-msg">{message}</p>}

      <ul className="backups-list">
        {entries.map((e) => (
          <li key={e.file}>
            <span>{new Date(e.createdAt).toLocaleString('pt-PT')}</span>
            <span>{formatBytes(e.sizeBytes)}</span>
            {confirmFile === e.file ? (
              <span className="backups-confirm">
                <input
                  placeholder="escreva RESTAURAR"
                  value={confirmText}
                  onChange={(ev) => setConfirmText(ev.target.value)}
                />
                <button
                  className="backups-danger"
                  disabled={busy || confirmText !== 'RESTAURAR'}
                  onClick={() => void doRestore(e.file)}
                >
                  Confirmar
                </button>
                <button onClick={() => { setConfirmFile(null); setConfirmText(''); }}>
                  Cancelar
                </button>
              </span>
            ) : (
              <button onClick={() => setConfirmFile(e.file)}>Restaurar</button>
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="backups-empty">Sem backups ainda.</li>}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Mount it in the Definições view**

Locate the settings/Definições render block in `src/renderer/App.tsx` (search for the settings form that renders the `companyName` field). Render `<BackupsPanel />` at the end of that settings section, after the existing settings form.

- [ ] **Step 4: Add styles**

Append to `src/renderer/styles.css`:
```css
.backups-panel { margin-top: 24px; border-top: 1px solid var(--border, #ddd); padding-top: 16px; }
.backups-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.backups-dir { font-size: 12px; opacity: 0.7; word-break: break-all; margin: 4px 0 0; }
.backups-msg { font-size: 13px; margin: 8px 0; }
.backups-list { list-style: none; padding: 0; margin: 12px 0 0; }
.backups-list li { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border, #eee); font-size: 13px; }
.backups-list li > span:first-child { flex: 1; }
.backups-confirm { display: flex; gap: 8px; align-items: center; }
.backups-confirm input { width: 140px; }
.backups-danger { background: #b3261e; color: #fff; }
.backups-empty { opacity: 0.6; }
```

- [ ] **Step 5: Checkpoint**

Run: `npm.cmd run typecheck` then `npx.cmd tsc -p tsconfig.main.json`
Expected: both clean.

---

## Task 9: Final validation

- [ ] **Step 1: Full automated suite**

Run: `npm.cmd run typecheck`
Run: `npm.cmd test`
Run: `npx.cmd tsc -p tsconfig.main.json`
Expected: typecheck clean; all Vitest files pass (paths, backup engine, backup routes, finance incl. backupDir, migrate, technical); main tsc no output.

- [ ] **Step 2: Live smoke (temp data dir, does not touch field DB)**

Boot the backend standalone with a temp `ISPM_DATA_DIR`, then:
- `GET http://127.0.0.1:3001/api/backups` → `entries` has ≥1 (the startup backup), `backupDir` ends with `\backups`.
- `POST http://127.0.0.1:3001/api/backups` → 200; list grows.
- Confirm a `.sqlite` file exists under `<tempdir>/backups`.
Clean up the temp dir afterwards.

- [ ] **Step 3: Manual Electron check**

In `npm.cmd run dev`: Definições → Backups lists backups; "Criar backup agora" adds one; "Restaurar" requires typing `RESTAURAR`; on confirm, in dev the message instructs to reopen (preload absent in dev — expected per Task 7).

---

## Self-Review

**Spec coverage:** startup auto-backup (Task 5) ✓; retention daily14+weekly8 (Task 2) ✓; configurable destination (Task 6 + `resolveBackupDir` Task 3) ✓; restore validate→snapshot→swap→restart (Tasks 4,5,7) ✓; `db.backup()` consistent copy (Task 3) ✓; availability>backup non-blocking (Task 5) ✓; path-traversal guard (Task 5) ✓; pre-restore never pruned (Task 2) ✓; old backup auto-migrated forward (Task 4 swaps; forward-migration guaranteed by ADR-0003 idempotent runner on reboot) ✓; UI panel (Task 8) ✓; YAGNI exclusions respected ✓.

**Placeholder scan:** No TBD/TODO. Renderer mount (Task 8 Step 3) is anchor-based into an existing 2300-line file — legitimate edit guidance; full component code provided.

**Type consistency:** `BackupEntry { file, createdAt, sizeBytes }` consistent Tasks 2–5; route `{ backupDir, entries }` consumed identically by `BackupsPanel`; `restoreBackup` → `{ restartRequired: true }` matched in route test and renderer; `closeDatabase` added Task 1, consumed Task 4.
