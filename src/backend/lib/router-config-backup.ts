import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { lineDiff } from '../../shared/line-diff';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import { createTransport, exportConfig, isRouterConfigured, readRouterConfig, type RouterTransport } from './routeros';

/**
 * A exportação abre com "# 2026-10-02 12:00:00 by RouterOS 7.24.2": a data muda a cada
 * exportação e faria de cada cópia uma versão nova. Sai do texto; a versão fica à parte.
 */
export function normalizeExport(raw: string): { content: string; routerosVersion: string | null } {
  let routerosVersion: string | null = null;
  const lines = raw.replace(/\r\n/g, '\n').split('\n').filter((line) => {
    const header = /^# .* by RouterOS (\S+)/.exec(line);
    if (header) routerosVersion = header[1];
    return !header;
  });
  return { content: lines.join('\n').trim(), routerosVersion };
}

export type SnapshotResult = { stored: boolean; id: number | null; addedLines: number; removedLines: number };

/**
 * Só grava quando a configuração difere da última cópia.
 * ponytail: guarda todas as versões (≈10 KB cada, a configuração muda pouco); podar as mais
 * antigas se a tabela pesar.
 */
export function storeSnapshot(db: Database.Database, raw: string, takenAt = new Date().toISOString()): SnapshotResult {
  const { content, routerosVersion } = normalizeExport(raw);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const last = db.prepare('SELECT sha256, content FROM router_config_snapshots ORDER BY id DESC LIMIT 1')
    .get() as { sha256: string; content: string } | undefined;
  if (last?.sha256 === sha256) return { stored: false, id: null, addedLines: 0, removedLines: 0 };
  const diff = last ? lineDiff(last.content, content) : [];
  const addedLines = diff.filter((line) => line.kind === 'added').length;
  const removedLines = diff.filter((line) => line.kind === 'removed').length;
  const id = Number(db.prepare(`INSERT INTO router_config_snapshots
      (taken_at, sha256, routeros_version, content, added_lines, removed_lines) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(takenAt, sha256, routerosVersion, content, addedLines, removedLines).lastInsertRowid);
  return { stored: true, id, addedLines, removedLines };
}

export async function backupRouterConfig(db: Database.Database, transport: RouterTransport, now = new Date()): Promise<SnapshotResult> {
  const result = storeSnapshot(db, await exportConfig(transport), now.toISOString());
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('routerConfigCheckedAt', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(now.toISOString());
  return result;
}

/** Uma leitura por dia: a que falha não conta, e volta a tentar no tick seguinte. */
export async function runRouterConfigBackupIfDue(now = new Date()) {
  const db = getSqliteDatabase();
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) return { skipped: true, reason: 'Router desligado ou por configurar' };
  const checkedAt = (db.prepare("SELECT value FROM app_settings WHERE key = 'routerConfigCheckedAt'").get() as { value: string } | undefined)?.value;
  if (checkedAt?.slice(0, 10) === now.toISOString().slice(0, 10)) return { skipped: true, reason: 'Já verificada hoje' };
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { skipped: true, reason: offNetworkReason(presence) };
  return backupRouterConfig(db, createTransport(config), now);
}

export type SnapshotSummary = {
  id: number; takenAt: string; routerosVersion: string | null; lines: number; addedLines: number; removedLines: number;
};

export function listSnapshots(db: Database.Database) {
  const checkedAt = (db.prepare("SELECT value FROM app_settings WHERE key = 'routerConfigCheckedAt'").get() as { value: string } | undefined)?.value ?? null;
  const snapshots = db.prepare(`SELECT id, taken_at AS takenAt, routeros_version AS routerosVersion,
      LENGTH(content) - LENGTH(REPLACE(content, char(10), '')) + 1 AS lines,
      added_lines AS addedLines, removed_lines AS removedLines
    FROM router_config_snapshots ORDER BY id DESC`).all() as SnapshotSummary[];
  return { checkedAt, snapshots };
}

export function loadSnapshot(db: Database.Database, id: number) {
  const row = db.prepare('SELECT id, taken_at AS takenAt, content FROM router_config_snapshots WHERE id = ?')
    .get(id) as { id: number; takenAt: string; content: string } | undefined;
  if (!row) return null;
  const previous = db.prepare('SELECT content FROM router_config_snapshots WHERE id < ? ORDER BY id DESC LIMIT 1')
    .get(id) as { content: string } | undefined;
  return { ...row, previousContent: previous?.content ?? null };
}
