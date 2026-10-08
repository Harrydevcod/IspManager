import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import {
  createTransport, DHCP_RELEASE, ensureLogJournal, isRouterConfigured, listAddresses, listLog, LOGIN_FAILURE, PPPOE_DROP, readLogJournal,
  readRouterConfig, ROGUE_DHCP,
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

export type JournalCursor = { time: string; seen: number };

// Medido no RouterOS 7.24: o ficheiro escreve "Oct/07/2026 23:40:51 tópicos mensagem", e não a
// data ISO que o /log devolve.
const JOURNAL_LINE = /^([A-Za-z]{3})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2}) (\S+) (.*)$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** As linhas do diário em disco, pela ordem do texto e com a hora no formato do /log. Pura. */
export function parseJournal(text: string): RouterLogEntry[] {
  const entries: RouterLogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = JOURNAL_LINE.exec(line);
    const month = match ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : 0;
    // Os ficheiros não trazem `.id`: a ordem serve de id para o collectFindings.
    if (match && month > 0) {
      entries.push({ id: `*${entries.length.toString(16)}`, time: `${match[3]}-${pad(month)}-${match[2]} ${match[4]}`, topics: match[5], message: match[6] });
    }
  }
  return entries;
}

/**
 * As linhas do diário que ainda não foram contadas. Os ficheiros rodam e não têm ids, por isso
 * o cursor é o segundo da última linha lida e quantas linhas desse segundo já se contaram.
 */
export function freshJournalLines(entries: RouterLogEntry[], cursor: JournalCursor | null): { fresh: RouterLogEntry[]; cursor: JournalCursor | null } {
  // ponytail: a hora é a do relógio do router; se ele arrancar com o relógio atrasado, as
  // linhas até o NTP acertar ficam antes do cursor e não contam. Cursor por ficheiro+posição se doer.
  let skip = cursor?.seen ?? 0;
  const fresh = entries.filter((entry) => {
    if (!cursor || entry.time > cursor.time) return true;
    if (entry.time < cursor.time) return false;
    return skip-- <= 0;
  });
  const last = fresh.at(-1);
  if (!last) return { fresh, cursor };
  const sameSecond = fresh.filter((entry) => entry.time === last.time).length;
  return { fresh, cursor: { time: last.time, seen: last.time === cursor?.time ? cursor.seen + sameSecond : sameSecond } };
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

const readJournalCursor = (db: Database.Database): JournalCursor | null => {
  try {
    const value = JSON.parse(readSetting(db, 'routerLogJournalCursor') ?? 'null') as Partial<JournalCursor> | null;
    return value && typeof value.time === 'string' && typeof value.seen === 'number' ? { time: value.time, seen: value.seen } : null;
  } catch {
    return null;
  }
};

/** O disco onde o router escreve o diário, ou `null` enquanto a vigia lê o registo em memória. */
export const journalDisk = (db: Database.Database) => readSetting(db, 'routerLogJournal');

/** Lê as linhas novas: do diário em disco se estiver instalado, senão do registo em memória. */
async function readFresh(db: Database.Database, transport: RouterTransport): Promise<{ fresh: RouterLogEntry[]; key: string; cursor: string | null }> {
  const disk = journalDisk(db);
  if (disk === null) {
    const { fresh, cursor } = freshEntries(await listLog(transport), readSetting(db, 'routerLogCursor'));
    return { fresh, key: 'routerLogCursor', cursor };
  }
  const previous = readJournalCursor(db);
  const { fresh, cursor } = freshJournalLines(parseJournal(await readLogJournal(transport, disk, previous?.time ?? null)), previous);
  return { fresh, key: 'routerLogJournalCursor', cursor: cursor && JSON.stringify(cursor) };
}

/**
 * Lê o registo do router e soma o que é novo. Só GETs no router.
 * Uma fonte de cada vez: o upsert soma contagens, e as duas contariam a dobrar.
 */
export async function watchRouterLog(db: Database.Database, transport: RouterTransport, now = new Date()) {
  const { fresh, key, cursor } = await readFresh(db, transport);
  const findings = fresh.length > 0 ? collectFindings(fresh, await listAddresses(transport), now) : [];
  const upsert = db.prepare(`INSERT INTO router_log_findings (day, kind, subject, label, count, first_at, last_at)
    VALUES (@day, @kind, @subject, @label, @count, @firstAt, @lastAt)
    ON CONFLICT(day, kind, subject) DO UPDATE SET count = count + excluded.count, label = excluded.label,
      first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)`);
  const setSetting = db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  db.transaction(() => {
    for (const finding of findings) upsert.run(finding);
    if (cursor !== null) setSetting.run(key, cursor);
    setSetting.run('routerLogReadAt', now.toISOString());
  })();
  return { lines: fresh.length, findings: findings.length };
}

/**
 * Liga o diário em disco e passa a vigia para ele. Conta primeiro o que a memória ainda tem;
 * o que já estiver nos ficheiros (reinstalação) fica para trás do cursor, sem contar.
 */
export async function installLogJournal(db: Database.Database, transport: RouterTransport, disk: string, now = new Date()) {
  // Já ligado: só se acerta a configuração no router; o cursor continua onde estava.
  if (journalDisk(db) !== null) return ensureLogJournal(transport, disk);
  await watchRouterLog(db, transport, now);
  await ensureLogJournal(transport, disk);
  const { cursor } = freshJournalLines(parseJournal(await readLogJournal(transport, disk, null)), null);
  const setSetting = db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  db.transaction(() => {
    setSetting.run('routerLogJournal', disk);
    setSetting.run('routerLogJournalCursor', JSON.stringify(cursor));
  })();
}

export async function runRouterLogWatchIfDue(now = new Date()) {
  const db = getSqliteDatabase();
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) return { skipped: true, reason: 'Router desligado ou por configurar' };
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { skipped: true, reason: offNetworkReason(presence) };
  return watchRouterLog(db, createTransport(config), now);
}
