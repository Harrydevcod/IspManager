import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { backupRouterConfig, listSnapshots, loadSnapshot, normalizeExport, storeSnapshot } from './router-config-backup';
import type { RouterTransport } from './routeros';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

const exported = (date: string, body: string) => `# ${date} by RouterOS 7.24.2\r\n# software id = ABCD-1234\r\n${body}\r\n`;
const router = (text: string): RouterTransport => async () => ({ ret: text });

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-router-config-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM router_config_snapshots').run();
  db.prepare("DELETE FROM app_settings WHERE key = 'routerConfigCheckedAt'").run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('cópia da configuração do router', () => {
  test('tira a linha da data e guarda a versão à parte', () => {
    expect(normalizeExport(exported('2026-10-02 12:00:00', '/ip address\nadd address=10.0.0.1/24')))
      .toEqual({ content: '# software id = ABCD-1234\n/ip address\nadd address=10.0.0.1/24', routerosVersion: '7.24.2' });
  });

  test('a mesma configuração exportada noutra hora não é uma versão nova', () => {
    expect(storeSnapshot(db, exported('2026-10-01 08:00:00', '/ip dns\nset servers=1.1.1.1')).stored).toBe(true);
    expect(storeSnapshot(db, exported('2026-10-02 09:30:00', '/ip dns\nset servers=1.1.1.1'))).toMatchObject({ stored: false, id: null });
    expect(listSnapshots(db).snapshots).toHaveLength(1);
  });

  test('uma alteração grava a versão com as linhas que entraram e saíram', () => {
    storeSnapshot(db, exported('2026-10-01 08:00:00', '/ip dns\nset servers=1.1.1.1'));
    const second = storeSnapshot(db, exported('2026-10-02 08:00:00', '/ip dns\nset servers=8.8.8.8\n/ip pool\nadd name=clientes'));
    expect(second).toMatchObject({ stored: true, addedLines: 3, removedLines: 1 });
    const [latest] = listSnapshots(db).snapshots;
    expect(latest).toMatchObject({ routerosVersion: '7.24.2', lines: 5, addedLines: 3, removedLines: 1 });
    const detail = loadSnapshot(db, second.id!);
    expect(detail?.content).toContain('8.8.8.8');
    expect(detail?.previousContent).toContain('1.1.1.1');
    expect(loadSnapshot(db, 999_999)).toBeNull();
  });

  test('copiar pelo router regista a verificação mesmo sem alterações', async () => {
    const text = exported('2026-10-02 08:00:00', '/ip dns\nset servers=1.1.1.1');
    expect((await backupRouterConfig(db, router(text), new Date('2026-10-02T08:00:00Z'))).stored).toBe(true);
    expect((await backupRouterConfig(db, router(text), new Date('2026-10-02T09:00:00Z'))).stored).toBe(false);
    expect(listSnapshots(db).checkedAt).toBe('2026-10-02T09:00:00.000Z');
  });

  test('uma resposta do router sem texto não grava nada', async () => {
    await expect(backupRouterConfig(db, async () => ({ ret: '' }))).rejects.toThrow();
    expect(listSnapshots(db)).toEqual({ checkedAt: null, snapshots: [] });
  });
});
