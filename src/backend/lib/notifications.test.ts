import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  companionUserId,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationReadByUid,
  markNotificationsSeen,
  notificationsSeenAt,
  pruneNotifications,
  recordNotification,
  unseenNotificationCount
} from './notifications';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let ana: number;
let bruno: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-notifications-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of ['notification_reads', 'notification_seen', 'notifications', 'app_settings', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insert = db.prepare("INSERT INTO users (username, password_hash, role, full_name, active) VALUES (?, 'x', ?, ?, 1)");
  ana = Number(insert.run('ana', 'admin', 'Ana').lastInsertRowid);
  bruno = Number(insert.run('bruno', 'operator', 'Bruno').lastInsertRowid);
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

const entry = (uid: string, extra: Record<string, unknown> = {}) => recordNotification(db, {
  uid,
  kind: 'job_error',
  severity: 'danger',
  title: `Falhou ${uid}`,
  ...extra
});

describe('sino: histórico de notificações', () => {
  test('o mesmo facto não entra duas vezes', () => {
    expect(entry('job:a:1')).toBeGreaterThan(0);
    expect(entry('job:a:1')).toBeNull();
    expect(listNotifications(db, ana)).toHaveLength(1);
  });

  test('lida por um utilizador não fica lida para o outro', () => {
    const id = entry('job:a:1')!;
    markNotificationRead(db, ana, id);
    expect(listNotifications(db, ana)[0].read).toBe(true);
    expect(listNotifications(db, bruno)[0].read).toBe(false);
  });

  test('marcar como lidas apanha tudo o que existe', () => {
    entry('job:a:1');
    entry('job:a:2');
    expect(markAllNotificationsRead(db, ana)).toBe(2);
    expect(listNotifications(db, ana).every((row) => row.read)).toBe(true);
    expect(listNotifications(db, bruno).some((row) => row.read)).toBe(false);
  });

  test('por ver conta o que nasceu depois de abrir o painel', () => {
    entry('job:a:1', { createdAt: '2026-11-19 09:00:00' });
    expect(unseenNotificationCount(db, ana)).toBe(1);
    markNotificationsSeen(db, ana, '2026-11-19 09:30:00');
    expect(unseenNotificationCount(db, ana)).toBe(0);
    entry('job:a:2', { createdAt: '2026-11-19 10:00:00' });
    expect(unseenNotificationCount(db, ana)).toBe(1);
    // ...e o outro utilizador continua com as duas por ver.
    expect(unseenNotificationCount(db, bruno)).toBe(2);
  });

  test('"visto até" nunca recua', () => {
    markNotificationsSeen(db, ana, '2026-11-19 10:00:00');
    markNotificationsSeen(db, ana, '2026-11-19 08:00:00');
    expect(notificationsSeenAt(db, ana)).toBe('2026-11-19 10:00:00');
  });

  test('o uid é a identidade partilhada com o telemóvel', () => {
    entry('phone:abc', { origin: 'phone' });
    expect(markNotificationReadByUid(db, ana, 'phone:abc')).toBe(true);
    expect(markNotificationReadByUid(db, ana, 'phone:nao-existe')).toBe(false);
    expect(listNotifications(db, ana)[0]).toMatchObject({ origin: 'phone', read: true });
  });

  test('a limpeza leva o que tem mais de 90 dias', () => {
    entry('velha', { createdAt: '2026-01-01 00:00:00' });
    entry('nova');
    expect(pruneNotifications(db)).toBe(1);
    expect(listNotifications(db, ana).map((row) => row.uid)).toEqual(['nova']);
  });
});

describe('quem o telemóvel representa', () => {
  test('sem pareamento guardado, o primeiro admin ativo', () => {
    expect(companionUserId(db)).toBe(ana);
  });

  test('com pareamento guardado, quem o confirmou', () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('smsCompanionUserId', ?)").run(String(bruno));
    expect(companionUserId(db)).toBe(bruno);
  });

  test('um utilizador apagado volta ao primeiro admin', () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('smsCompanionUserId', '999')").run();
    expect(companionUserId(db)).toBe(ana);
  });
});
