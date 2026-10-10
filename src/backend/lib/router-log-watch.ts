import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import { compactEntries } from './router-log-reading';
import {
  createTransport, DHCP_RELEASE, ensureLogJournal, isRouterConfigured, listAddresses, listInterfaces, listLog, LOGIN_FAILURE, PPPOE_DROP,
  readLogJournal, readRouterConfig, ROGUE_DHCP,
  type RouterLogEntry, type RouterTransport
} from './routeros';

export const FINDING_KINDS = ['antena_em_baixo', 'ip_duplicado', 'laco_rede', 'dhcp_intruso', 'dhcp_ciclo', 'pppoe_queda', 'login_falhado'] as const;
export type FindingKind = typeof FINDING_KINDS[number];

/** O que o router diz de si próprio: é contra isto que se lê um DHCP numa porta não confiável. */
export type RouterIdentity = { addresses: string[]; macs: string[] };

export type Finding = {
  day: string; kind: FindingKind; subject: string; label: string; count: number; firstAt: string; lastAt: string;
};

// A linha do próprio netwatch, não a do script que o operador lhe pendurou: essa muda de texto.
const NETWATCH_DOWN = /^event down \[ type: \w+, host: (\S+) \]/;

const idNumber = (id: string) => Number.parseInt(id.replace(/^\*/, ''), 16) || 0;
const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** As linhas guardadas vivem isto; o cartão do router guarda menos. */
export const LOG_RETENTION_DAYS = 90;
// Marca de que o cartão já foi lido todo para as linhas guardadas (ou de que não havia nada atrás).
const LINES_RECOVERED = 'routerLogLinesRecovered';
// Marca de que as linhas guardadas antes de se encurtarem as gravações dos contadores já foram limpas.
const LINES_COMPACTED = 'routerLogLinesCompacted';

/** A hora completa de uma linha: o RouterOS pode escrever só a hora nas de hoje. */
const entryTime = (entry: RouterLogEntry, now: Date) => /^\d{4}-\d{2}-\d{2} /.test(entry.time) ? entry.time : `${localDay(now)} ${entry.time}`;
const inLogOrder = (entries: RouterLogEntry[]) => [...entries].sort((a, b) => idNumber(a.id) - idNumber(b.id));

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
 * por esse endereço — foi isso que pôs as antenas a cair em 2026-10-06. Se o MAC também for
 * do router, é a resposta dele a voltar-lhe por um laço na rede (2026-10-08), e não há
 * intruso nenhum para procurar.
 */
export function collectFindings(entries: RouterLogEntry[], router: RouterIdentity, now = new Date()): Finding[] {
  const routerMacs = router.macs.map((mac) => mac.toUpperCase());
  const found = new Map<string, Finding>();
  const add = (at: string, kind: FindingKind, subject: string, label: string) => {
    const day = at.slice(0, 10);
    const row = found.get(`${day}|${kind}|${subject}`);
    if (row) Object.assign(row, { count: row.count + 1, label, lastAt: at });
    else found.set(`${day}|${kind}|${subject}`, { day, kind, subject, label, count: 1, firstAt: at, lastAt: at });
  };
  for (const entry of inLogOrder(entries)) {
    const at = entryTime(entry, now);
    const message = entry.message.trim();
    let match: RegExpExecArray | null;
    if ((match = NETWATCH_DOWN.exec(message))) add(at, 'antena_em_baixo', match[1], '');
    else if ((match = ROGUE_DHCP.exec(message))) {
      const mac = match[3].toUpperCase();
      const kind = routerMacs.includes(mac) ? 'laco_rede' : router.addresses.includes(match[2]) ? 'ip_duplicado' : 'dhcp_intruso';
      add(at, kind, mac, `${match[1]} · ${match[2]}`);
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

type Reading = { fresh: RouterLogEntry[]; key: string; cursor: string | null; recovered: RouterLogEntry[] | null };

/**
 * Lê as linhas novas: do diário em disco se estiver instalado, senão do registo em memória.
 *
 * Uma vez na vida, lê o cartão todo: as linhas atrás do cursor já foram contadas quando ainda
 * não se guardavam, e só o cartão as tem. `recovered` é `null` quando não era a vez disso.
 */
async function readFresh(db: Database.Database, transport: RouterTransport): Promise<Reading> {
  const disk = journalDisk(db);
  if (disk === null) {
    const { fresh, cursor } = freshEntries(await listLog(transport), readSetting(db, 'routerLogCursor'));
    return { fresh, key: 'routerLogCursor', cursor, recovered: null };
  }
  const previous = readJournalCursor(db);
  const read = async (since: string | null) => {
    const entries = parseJournal(await readLogJournal(transport, disk, since));
    const { fresh, cursor } = freshJournalLines(entries, previous);
    const counted = new Set(fresh);
    return {
      reading: { fresh, key: 'routerLogJournalCursor', cursor: cursor && JSON.stringify(cursor) },
      older: entries.filter((entry) => !counted.has(entry))
    };
  };
  if (previous === null || readSetting(db, LINES_RECOVERED) !== null) {
    return { ...(await read(previous?.time ?? null)).reading, recovered: null };
  }
  try {
    const { reading, older } = await read(null);
    return { ...reading, recovered: older };
  } catch {
    // ponytail: um ficheiro que o router corta rebenta a leitura do cartão inteiro. Desiste-se
    // do que está para trás em vez de parar a vigia de 5 em 5 minutos; ler ficheiro a ficheiro se doer.
    return { ...(await read(previous.time)).reading, recovered: [] };
  }
}

async function readRouterIdentity(transport: RouterTransport): Promise<RouterIdentity> {
  const [addresses, interfaces] = await Promise.all([listAddresses(transport), listInterfaces(transport)]);
  const macs = interfaces.map((item) => item.macAddress?.toUpperCase()).filter((mac): mac is string => Boolean(mac));
  return { addresses, macs: [...new Set(macs)] };
}

/**
 * Tira das linhas já guardadas o peso das gravações dos contadores (os totais das WAN e do
 * consumo vinham inteiros, de hora a hora). Devolve quantas linhas saíram.
 */
export function compactStoredLines(db: Database.Database): number {
  const rows = db.prepare("SELECT id, at, topics, message FROM router_log_lines WHERE topics = 'system,info' ORDER BY id")
    .all() as Array<{ id: number; at: string; topics: string; message: string }>;
  const kept = new Map(compactEntries(rows.map((row) => ({ id: `*${row.id.toString(16)}`, time: row.at, topics: row.topics, message: row.message })))
    .map((entry) => [idNumber(entry.id), entry.message]));
  const drop = db.prepare('DELETE FROM router_log_lines WHERE id = ?');
  const shorten = db.prepare('UPDATE router_log_lines SET message = ? WHERE id = ?');
  for (const row of rows) {
    const message = kept.get(row.id);
    if (message === undefined) drop.run(row.id);
    else if (message !== row.message) shorten.run(message, row.id);
  }
  return rows.length - kept.size;
}

/**
 * Lê o registo do router e soma o que é novo. Só GETs no router.
 * Uma fonte de cada vez: o upsert soma contagens, e as duas contariam a dobrar.
 */
export async function watchRouterLog(db: Database.Database, transport: RouterTransport, now = new Date()) {
  const { fresh, key, cursor, recovered } = await readFresh(db, transport);
  const router = fresh.length > 0 ? await readRouterIdentity(transport) : null;
  const findings = router ? collectFindings(fresh, router, now) : [];
  const MERGE = `ON CONFLICT(day, kind, subject) DO UPDATE SET count = count + excluded.count, label = excluded.label,
      first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)`;
  const upsert = db.prepare(`INSERT INTO router_log_findings (day, kind, subject, label, count, first_at, last_at)
    VALUES (@day, @kind, @subject, @label, @count, @firstAt, @lastAt) ${MERGE}`);
  // Antes de a vigia conhecer os MAC do router, um laço gravava-se como endereço duplicado.
  const moveToLoop = db.prepare(`INSERT INTO router_log_findings (day, kind, subject, label, count, first_at, last_at)
    SELECT day, 'laco_rede', subject, label, count, first_at, last_at FROM router_log_findings
    WHERE kind = 'ip_duplicado' AND subject = ? ${MERGE}`);
  const dropDuplicate = db.prepare("DELETE FROM router_log_findings WHERE kind = 'ip_duplicado' AND subject = ?");
  const setSetting = db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const keepLine = db.prepare('INSERT INTO router_log_lines (at, topics, message) VALUES (?, ?, ?)');
  const dropOldLines = db.prepare('DELETE FROM router_log_lines WHERE at < ?');
  db.transaction(() => {
    if (readSetting(db, LINES_COMPACTED) === null) {
      compactStoredLines(db);
      setSetting.run(LINES_COMPACTED, now.toISOString());
    }
    // Guarda-se o que aconteceu, não os totais que os contadores despejam no registo.
    for (const entry of [...compactEntries(inLogOrder(recovered ?? [])), ...compactEntries(inLogOrder(fresh))]) {
      keepLine.run(entryTime(entry, now), entry.topics, entry.message);
    }
    dropOldLines.run(localDay(new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000)));
    if (recovered !== null) setSetting.run(LINES_RECOVERED, now.toISOString());
    for (const mac of router?.macs ?? []) {
      moveToLoop.run(mac);
      dropDuplicate.run(mac);
    }
    for (const finding of findings) upsert.run(finding);
    if (cursor !== null) setSetting.run(key, cursor);
    setSetting.run('routerLogReadAt', now.toISOString());
  })();
  return { lines: fresh.length, findings: findings.length, ...(recovered !== null && { recovered: recovered.length }) };
}

/** Os dias que têm linhas guardadas, do mais recente para o mais antigo. */
export function listLogDays(db: Database.Database): Array<{ day: string; lines: number }> {
  return db.prepare('SELECT substr(at, 1, 10) AS day, COUNT(*) AS lines FROM router_log_lines GROUP BY day ORDER BY day DESC')
    .all() as Array<{ day: string; lines: number }>;
}

/** As linhas de um dia pela ordem em que o router as escreveu, no formato do registo ao vivo. */
export function loadLogDay(db: Database.Database, day: string): RouterLogEntry[] {
  const rows = db.prepare('SELECT id, at, topics, message FROM router_log_lines WHERE at >= ? AND at < ? ORDER BY id')
    .all(day, `${day} 99`) as Array<{ id: number; at: string; topics: string; message: string }>;
  // O ecrã ordena pelo `.id` hexadecimal do registo ao vivo: dá-se-lhe o mesmo feitio.
  return rows.map((row) => ({ id: `*${row.id.toString(16)}`, time: row.at, topics: row.topics, message: row.message }));
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
    // O que a memória tinha já ficou guardado; o cartão, daqui para trás, repetia-o.
    setSetting.run(LINES_RECOVERED, now.toISOString());
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
