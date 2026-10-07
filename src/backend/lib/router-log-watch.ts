import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import {
  createTransport, DHCP_RELEASE, isRouterConfigured, listAddresses, listLog, LOGIN_FAILURE, PPPOE_DROP, readRouterConfig, ROGUE_DHCP,
  type RouterLogEntry, type RouterTransport
} from './routeros';

export const FINDING_KINDS = ['antena_em_baixo', 'ip_duplicado', 'dhcp_intruso', 'dhcp_ciclo', 'pppoe_queda', 'login_falhado'] as const;
export type FindingKind = typeof FINDING_KINDS[number];

export type Finding = {
  day: string; kind: FindingKind; subject: string; label: string; count: number; firstAt: string; lastAt: string;
};

// A linha do próprio netwatch, não a do script que o operador lhe pendurou: essa muda de texto.
const NETWATCH_DOWN = /^event down \[ type: \w+, host: (\S+) \]/;

const idNumber = (id: string) => Number.parseInt(id.replace(/^\*/, ''), 16) || 0;
const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * As linhas que ainda não foram contadas. O `.id` do registo cresce sempre até o router
 * reiniciar; se o maior id lido for menor do que o cursor, o registo recomeçou e conta tudo.
 */
export function freshEntries(entries: RouterLogEntry[], cursor: string | null): { fresh: RouterLogEntry[]; cursor: string | null } {
  if (entries.length === 0) return { fresh: [], cursor };
  const newest = entries.reduce((max, entry) => idNumber(entry.id) > idNumber(max.id) ? entry : max);
  const after = cursor !== null && idNumber(newest.id) >= idNumber(cursor) ? idNumber(cursor) : -1;
  return { fresh: entries.filter((entry) => idNumber(entry.id) > after), cursor: newest.id };
}

/**
 * O que as linhas dizem, somado por dia e por sujeito. Pura.
 * Um DHCP intruso que anuncia um endereço do próprio router é outro equipamento a responder
 * por esse endereço — foi isso que pôs as antenas a cair em 2026-10-06.
 */
export function collectFindings(entries: RouterLogEntry[], routerAddresses: string[], now = new Date()): Finding[] {
  const found = new Map<string, Finding>();
  const add = (at: string, kind: FindingKind, subject: string, label: string) => {
    const day = at.slice(0, 10);
    const row = found.get(`${day}|${kind}|${subject}`);
    if (row) Object.assign(row, { count: row.count + 1, label, lastAt: at });
    else found.set(`${day}|${kind}|${subject}`, { day, kind, subject, label, count: 1, firstAt: at, lastAt: at });
  };
  for (const entry of [...entries].sort((a, b) => idNumber(a.id) - idNumber(b.id))) {
    // O RouterOS pode escrever só a hora nas linhas de hoje.
    const at = /^\d{4}-\d{2}-\d{2} /.test(entry.time) ? entry.time : `${localDay(now)} ${entry.time}`;
    const message = entry.message.trim();
    let match: RegExpExecArray | null;
    if ((match = NETWATCH_DOWN.exec(message))) add(at, 'antena_em_baixo', match[1], '');
    else if ((match = ROGUE_DHCP.exec(message))) {
      add(at, routerAddresses.includes(match[2]) ? 'ip_duplicado' : 'dhcp_intruso', match[3].toUpperCase(), `${match[1]} · ${match[2]}`);
    } else if ((match = PPPOE_DROP.exec(message))) add(at, 'pppoe_queda', match[1], match[2]);
    else if ((match = DHCP_RELEASE.exec(message))) add(at, 'dhcp_ciclo', match[2].toUpperCase(), [match[3], match[1]].filter(Boolean).join(' · '));
    else if ((match = LOGIN_FAILURE.exec(message))) add(at, 'login_falhado', `${match[2]} ${match[3]}`, match[1]);
  }
  return [...found.values()];
}

const readSetting = (db: Database.Database, key: string) =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

/** Lê o registo do router e soma o que é novo. Só GETs no router. */
export async function watchRouterLog(db: Database.Database, transport: RouterTransport, now = new Date()) {
  const { fresh, cursor } = freshEntries(await listLog(transport), readSetting(db, 'routerLogCursor'));
  const findings = fresh.length > 0 ? collectFindings(fresh, await listAddresses(transport), now) : [];
  const upsert = db.prepare(`INSERT INTO router_log_findings (day, kind, subject, label, count, first_at, last_at)
    VALUES (@day, @kind, @subject, @label, @count, @firstAt, @lastAt)
    ON CONFLICT(day, kind, subject) DO UPDATE SET count = count + excluded.count, label = excluded.label,
      first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)`);
  const setSetting = db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  db.transaction(() => {
    for (const finding of findings) upsert.run(finding);
    if (cursor !== null) setSetting.run('routerLogCursor', cursor);
    setSetting.run('routerLogReadAt', now.toISOString());
  })();
  return { lines: fresh.length, findings: findings.length };
}

export async function runRouterLogWatchIfDue(now = new Date()) {
  const db = getSqliteDatabase();
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) return { skipped: true, reason: 'Router desligado ou por configurar' };
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { skipped: true, reason: offNetworkReason(presence) };
  return watchRouterLog(db, createTransport(config), now);
}
