import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  selectForRetention,
  createBackup,
  listBackups,
  pruneBackups,
  validateBackup,
  validateBackupDir,
  restoreBackup,
  runScheduledBackupIfDue,
  type BackupEntry,
} from './backup';
import { runMigrations } from '../db/migrate';
import { getSqliteDatabase, closeDatabase } from '../db/database';

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

  test('groups entries in the same ISO week across a year boundary', () => {
    // 2024-12-30 (Mon) and 2025-01-02 (Thu) are both ISO week 2025-W1.
    // Both are older than the 14-day daily window, so weekly retention
    // applies: only the newest of the two is kept.
    const crossYear = [
      entry('2024-12-30T10:00:00'),
      entry('2025-01-02T10:00:00'),
    ];
    const toDelete = selectForRetention(crossYear, now);
    expect(toDelete).toHaveLength(1);
    expect(toDelete[0].createdAt.getFullYear()).toBe(2024);
  });
});

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

  // On Windows an open better-sqlite3 handle (the getSqliteDatabase
  // singleton opened inside createBackup) keeps a lock on the temp file,
  // so the singleton must be closed before removing the temp directory.
  function cleanup(): void {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  test('createBackup produces a valid migrated copy', async () => {
    setData();
    const e = await createBackup('manual');
    const full = path.join(dir, 'backups', e.file);
    expect(existsSync(full)).toBe(true);
    expect(validateBackup(full).ok).toBe(true);
    cleanup();
  });

  test('a backup is a self-contained single file (no WAL/SHM sidecars after open)', async () => {
    setData();
    const e = await createBackup('manual');
    const backupsDir = path.join(dir, 'backups');
    // Opening the backup (validate, restore, ...) must never spawn WAL/SHM
    // litter beside it: a stale -wal next to a backup is a silent footgun.
    expect(validateBackup(path.join(backupsDir, e.file)).ok).toBe(true);
    const sidecars = readdirSync(backupsDir).filter(
      (f) => f.endsWith('-wal') || f.endsWith('-shm'),
    );
    expect(sidecars).toEqual([]);
    cleanup();
  });

  test('validateBackup rejects a corrupt file', () => {
    setData();
    const bad = path.join(dir, 'bad.sqlite');
    writeFileSync(bad, 'not a database');
    expect(validateBackup(bad).ok).toBe(false);
    cleanup();
  });

  test('validateBackup rejects a pre-migrations database', () => {
    setData();
    const plain = path.join(dir, 'plain.sqlite');
    const d = new Database(plain);
    d.exec('CREATE TABLE x (a TEXT);');
    d.close();
    expect(validateBackup(plain).ok).toBe(false);
    cleanup();
  });

  test('listBackups + pruneBackups apply retention', async () => {
    setData();
    await createBackup('manual');
    await createBackup('manual');
    expect(listBackups().length).toBeGreaterThanOrEqual(1);
    expect(() => pruneBackups()).not.toThrow();
    cleanup();
  });
});

describe('validateBackupDir', () => {
  test('empty string is valid (use default dir)', () => {
    expect(validateBackupDir('')).toBeNull();
    expect(validateBackupDir('   ')).toBeNull();
  });

  test('an existing writable directory is valid', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ispm-bkd-'));
    expect(validateBackupDir(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a non-existent path is rejected', () => {
    expect(validateBackupDir(path.join(tmpdir(), 'definitely-not-here-xyz'))).toMatch(/inexistente/i);
  });
});

describe('runScheduledBackupIfDue', () => {
  let dir: string;

  function setData(): void {
    dir = mkdtempSync(path.join(tmpdir(), 'ispm-sched-'));
    process.env.ISPM_DATA_DIR = dir;
    const db = new Database(path.join(dir, 'ispm.sqlite'));
    runMigrations(db);
    db.close();
  }

  function setInterval(hours: number): void {
    getSqliteDatabase()
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('backupIntervalHours', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(hours));
  }

  function cleanup(): void {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  test('skips when scheduling is disabled (interval 0)', async () => {
    setData();
    const result = await runScheduledBackupIfDue(new Date());
    expect(result).toEqual({ skipped: 'agendamento desligado' });
    expect(listBackups()).toHaveLength(0);
    cleanup();
  });

  test('runs when no backup exists yet', async () => {
    setData();
    setInterval(24);
    const result = await runScheduledBackupIfDue(new Date());
    expect('ran' in result).toBe(true);
    expect(listBackups().some((e) => e.file.startsWith('ispm-'))).toBe(true);
    cleanup();
  });

  test('skips while still inside the interval', async () => {
    setData();
    setInterval(24);
    await createBackup('manual'); // backup recente
    const result = await runScheduledBackupIfDue(new Date());
    expect(result).toEqual({ skipped: 'ainda dentro do intervalo' });
    cleanup();
  });

  test('runs again once the interval has elapsed', async () => {
    setData();
    setInterval(24);
    const first = await createBackup('manual');
    const later = new Date(first.createdAt.getTime() + 25 * 3_600_000);
    const result = await runScheduledBackupIfDue(later);
    expect('ran' in result).toBe(true);
    cleanup();
  });
});

describe('restoreBackup', () => {
  test('rejects an invalid file without mutating state', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ispm-rs-'));
    process.env.ISPM_DATA_DIR = dir;
    const live = new Database(path.join(dir, 'ispm.sqlite'));
    runMigrations(live);
    live.close();

    const bad = path.join(dir, 'bad.sqlite');
    writeFileSync(bad, 'garbage');
    await expect(restoreBackup(bad)).rejects.toThrow();
    // A rejected restore must not even create the backups dir (it throws
    // in validateBackup before resolveBackupDir runs); a missing dir is
    // therefore stronger evidence of "no snapshot" than an empty one.
    const backupsDir = path.join(dir, 'backups');
    const snaps = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((f) => f.startsWith('pre-restore-'))
      : [];
    expect(snaps).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('valid restore snapshots current DB and swaps the file', async () => {
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

    const res = await restoreBackup(backupFile);
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

  test('pre-restore snapshot is consistent and contains writes made just before restore', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ispm-rs3-'));
    process.env.ISPM_DATA_DIR = dir;
    const db = getSqliteDatabase();
    db.prepare(
      `INSERT INTO clients (client_code, full_name) VALUES (?, ?)`,
    ).run('SNAP-1', 'Snap Row');

    const fresh = new Database(path.join(dir, 'src.sqlite'));
    runMigrations(fresh);
    fresh.close();
    const bdir = path.join(dir, 'backups');
    mkdirSync(bdir, { recursive: true });
    const backupFile = path.join(bdir, 'ispm-20260101-000000.sqlite');
    copyFileSync(path.join(dir, 'src.sqlite'), backupFile);

    const res = await restoreBackup(backupFile);
    expect(res.snapshotPath).toBeDefined();
    expect(validateBackup(res.snapshotPath as string).ok).toBe(true);
    const snap = new Database(res.snapshotPath as string, { readonly: true });
    const row = snap
      .prepare('SELECT full_name FROM clients WHERE client_code = ?')
      .get('SNAP-1') as { full_name: string } | undefined;
    snap.close();
    expect(row?.full_name).toBe('Snap Row');
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
});
