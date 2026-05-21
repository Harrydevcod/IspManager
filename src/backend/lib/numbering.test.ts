import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSqliteDatabase, closeDatabase } from '../db/database';
import { readDocumentPrefix, nextDocumentNumber } from './numbering';

let dir: string;

/**
 * Each test gets a fresh migrated DB in its own temp dir. The first
 * getSqliteDatabase() call lazily opens the connection and runs the
 * migration chain, so app_settings exists (empty) afterwards.
 */
function freshDb(): Database.Database {
  closeDatabase();
  dir = mkdtempSync(path.join(tmpdir(), 'ispm-num-'));
  process.env.ISPM_DATA_DIR = dir;
  return getSqliteDatabase();
}

function setPrefix(db: Database.Database, key: 'invoicePrefix' | 'receiptPrefix', value: string): void {
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  ).run(key, value);
}

// On Windows the open better-sqlite3 handle locks the temp file, so the
// singleton must be closed before the directory can be removed.
afterEach(() => {
  closeDatabase();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('readDocumentPrefix', () => {
  test('falls back to FT / RC when no setting is stored', () => {
    freshDb();
    expect(readDocumentPrefix('invoice')).toBe('FT');
    expect(readDocumentPrefix('receipt')).toBe('RC');
  });

  test('returns the configured prefix when present', () => {
    const db = freshDb();
    setPrefix(db, 'invoicePrefix', 'ACME');
    setPrefix(db, 'receiptPrefix', 'REC');
    expect(readDocumentPrefix('invoice')).toBe('ACME');
    expect(readDocumentPrefix('receipt')).toBe('REC');
  });

  test('falls back when the stored value is empty or whitespace', () => {
    const db = freshDb();
    setPrefix(db, 'invoicePrefix', '   ');
    setPrefix(db, 'receiptPrefix', '');
    expect(readDocumentPrefix('invoice')).toBe('FT');
    expect(readDocumentPrefix('receipt')).toBe('RC');
  });

  test('trims surrounding whitespace from a configured prefix', () => {
    const db = freshDb();
    setPrefix(db, 'invoicePrefix', '  FAT  ');
    expect(readDocumentPrefix('invoice')).toBe('FAT');
  });
});

describe('nextDocumentNumber', () => {
  test('formats as PREFIX-YEAR-00000 with the default prefix', () => {
    freshDb();
    const year = new Date().getFullYear();
    expect(nextDocumentNumber('invoice', 7)).toBe(`FT-${year}-00007`);
    expect(nextDocumentNumber('receipt', 1)).toBe(`RC-${year}-00001`);
  });

  test('uses the configured prefix from app_settings', () => {
    const db = freshDb();
    setPrefix(db, 'invoicePrefix', 'ACME');
    const year = new Date().getFullYear();
    expect(nextDocumentNumber('invoice', 42)).toBe(`ACME-${year}-00042`);
  });

  test('zero-pads to 5 digits and never truncates a longer id', () => {
    freshDb();
    const year = new Date().getFullYear();
    expect(nextDocumentNumber('invoice', 0)).toBe(`FT-${year}-00000`);
    expect(nextDocumentNumber('invoice', 123456)).toBe(`FT-${year}-123456`);
  });
});
