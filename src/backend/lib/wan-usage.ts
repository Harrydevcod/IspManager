import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import { createTransport, isRouterConfigured, listInterfaceListMembers, listInterfaces, readRouterConfig, readWanUsageData, type RouterTransport } from './routeros';
import { refreshUsageCounterForJob, usageCounterDisk } from './usage-counter';

/**
 * O dia é o UTC, como o da conta Starlink ("seguida no fuso horário UTC"): em Cabo Verde
 * (UTC−1) cada dia vai da 01:00 à 01:00 locais. Dias gravados antes de 2026-09-30 são locais.
 */
export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function counterDelta(last: number | null, current: number): number {
  if (last === null) return 0;
  return current >= last ? current - last : current;
}

type CounterState = { rxLast: number; txLast: number };
type WanUsageSource = 'counted' | 'starlink';
type UsageRow ={ interface: string; rxBytes: number; txBytes: number };
export type RouterUsageRow = { day: string; interface: string; rxBytes: number; txBytes: number };

export function parseWanUsageFile(text: string): RouterUsageRow[] {
  // No dia da passagem para UTC há uma linha da v5 (dia local, até à mudança) e outra da v6
  // (dia UTC, desde a mudança) para o mesmo dia: são troços diferentes, somam-se.
  const merged = new Map<string, RouterUsageRow>();
  for (const row of parseLines(text)) {
    const key = `${row.day};${row.interface}`;
    const existing = merged.get(key);
    if (existing) {
      existing.rxBytes += row.rxBytes;
      existing.txBytes += row.txBytes;
    } else {
      merged.set(key, { ...row });
    }
  }
  return [...merged.values()];
}

function parseLines(text: string): RouterUsageRow[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const parts = line.replace(/^# /, '').split(';');
    // O router grava o dia como dias desde 1970 (UTC), para não fazer contas de datas no RouterOS.
    if (/^\d{1,6}$/.test(parts[0])) parts[0] = new Date(Number(parts[0]) * 86_400_000).toISOString().slice(0, 10);
    if (parts.length !== 4 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0]) || !parts[1] ||
      !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return [];
    const rxBytes = Number(parts[2]);
    const txBytes = Number(parts[3]);
    if (!Number.isSafeInteger(rxBytes) || !Number.isSafeInteger(txBytes)) return [];
    return [{ day: parts[0], interface: parts[1], rxBytes, txBytes }];
  });
}

/** `# last;iface;rx;tx`: o contador que o router viu na última gravação. */
export function parseWanUsageLast(text: string): Map<string, { rx: number; tx: number }> {
  const last = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^# last;([^;]+);(\d+);(\d+)$/.exec(line);
    if (match) last.set(match[1], { rx: Number(match[2]), tx: Number(match[3]) });
  }
  return last;
}

// MAX, não sobrescrever: no dia da instalação o router só conta desde a instalação e o ISPM
// já tinha o dia até ali. Depois disso o fallback para, e o router só cresce dentro do dia.
export function importRouterUsage(db: Database.Database, rows: RouterUsageRow[]) {
  const upsert = db.prepare(`
    INSERT INTO wan_traffic_daily (day, interface, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, interface) DO UPDATE SET
      rx_bytes = MAX(rx_bytes, excluded.rx_bytes), tx_bytes = MAX(tx_bytes, excluded.tx_bytes)
      WHERE wan_traffic_daily.source = 'counted'
  `);
  return db.transaction(() => {
    for (const row of rows) upsert.run(row.day, row.interface, row.rxBytes, row.txBytes);
    const importedAt = new Date().toISOString();
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('wanUsageRouterImportedAt', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(importedAt);
    // O router apaga linhas com mais de 30 dias: guarda-se o primeiro dia que alguma vez contou.
    const firstDay = rows.reduce<string | null>((min, row) => (min === null || row.day < min ? row.day : min), null);
    if (firstDay) {
      db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('wanUsageRouterFirstDay', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = MIN(value, excluded.value), updated_at = excluded.updated_at`).run(firstDay);
    }
    return { source: 'router' as const, rows: rows.length, importedAt };
  })();
}

export type StarlinkUsageRow = { day: string; interface: string; bytes: number };

/**
 * Dias copiados da conta Starlink, que só mostra o total (↓+↑): fica tudo em rx e o tx a zero, sem
 * inventar a divisão. Substitui o que lá estiver e a importação do router deixa de tocar no dia.
 */
export function importStarlinkUsage(db: Database.Database, rows: StarlinkUsageRow[]) {
  for (const row of rows) {
    const parsed = Date.parse(`${row.day}T00:00:00Z`);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== row.day) throw new Error(`Dia inválido: ${row.day}`);
    if (!row.interface) throw new Error('Interface em falta');
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error(`Bytes inválidos em ${row.day} ${row.interface}`);
  }
  const upsert = db.prepare(`
    INSERT INTO wan_traffic_daily (day, interface, rx_bytes, tx_bytes, source) VALUES (?, ?, ?, 0, 'starlink')
    ON CONFLICT(day, interface) DO UPDATE SET rx_bytes = excluded.rx_bytes, tx_bytes = 0, source = 'starlink'
  `);
  db.transaction(() => { for (const row of rows) upsert.run(row.day, row.interface, row.bytes); })();
  return { rows: rows.length };
}

export async function recordWanUsage(db: Database.Database, transport: RouterTransport, today = utcDay()) {
  const names = new Set(await listInterfaceListMembers(transport, 'WAN'));
  const interfaces = (await listInterfaces(transport))
    .filter((item) => names.has(item.name) && item.rxBytes !== null && item.txBytes !== null);
  const state = db.prepare('SELECT rx_last AS rxLast, tx_last AS txLast FROM wan_counter_state WHERE interface = ?');
  const add = db.prepare(`
    INSERT INTO wan_traffic_daily (day, interface, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, interface) DO UPDATE SET
      rx_bytes = rx_bytes + excluded.rx_bytes,
      tx_bytes = tx_bytes + excluded.tx_bytes
      WHERE wan_traffic_daily.source = 'counted'
  `);
  const save = db.prepare(`
    INSERT INTO wan_counter_state (interface, rx_last, tx_last, seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(interface) DO UPDATE SET
      rx_last = excluded.rx_last, tx_last = excluded.tx_last
  `);
  const seenAt = new Date().toISOString();
  return db.transaction(() => {
    let rxBytes = 0;
    let txBytes = 0;
    for (const item of interfaces) {
      const previous = state.get(item.name) as CounterState | undefined;
      const rx = counterDelta(previous?.rxLast ?? null, item.rxBytes!);
      const tx = counterDelta(previous?.txLast ?? null, item.txBytes!);
      // Fallback apenas: sem ficheiro do router, o tráfego com a app fechada fica no dia da reabertura.
      add.run(today, item.name, rx, tx);
      save.run(item.name, item.rxBytes, item.txBytes, seenAt);
      rxBytes += rx;
      txBytes += tx;
    }
    return { interfaces: interfaces.length, rxBytes, txBytes };
  })();
}

export async function runWanUsageIfDue() {
  const db = getSqliteDatabase();
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) {
    return { skipped: true, reason: 'Router desligado ou por configurar' };
  }
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { skipped: true, reason: offNetworkReason(presence) };
  const transport = createTransport(config);
  // Um contador já instalado numa versão antiga atualiza-se aqui; se falhar, conta-se na mesma.
  const installed = db.prepare("SELECT 1 FROM app_settings WHERE key = 'wanUsageRouterImportedAt'").get() !== undefined;
  const counter = config.dryRun ? {} : await refreshUsageCounterForJob(db, transport, 'wan', installed);
  return { ...await collectWanUsage(db, transport), ...counter };
}

export async function collectWanUsage(db: Database.Database, transport: RouterTransport, today = utcDay()) {
  const data = await readWanUsageData(transport, usageCounterDisk(db, 'wan'));
  const rows = data === null ? [] : parseWanUsageFile(data);
  // Script de dados vazio = o contador do router ainda não somou nada: não se deixa de contar.
  if (rows.length > 0) {
    // O router só grava de hora a hora (cada gravação é uma linha no registo dele). Com a app
    // aberta, soma-se a hoje o que passou desde essa gravação; o MAX da importação deixa a
    // próxima gravação do router, que já inclui isto, tomar o lugar.
    const last = parseWanUsageLast(data!);
    for (const item of await listInterfaces(transport)) {
      const previous = last.get(item.name);
      if (!previous || item.rxBytes === null || item.txBytes === null) continue;
      let row = rows.find((candidate) => candidate.day === today && candidate.interface === item.name);
      if (!row) rows.push(row = { day: today, interface: item.name, rxBytes: 0, txBytes: 0 });
      row.rxBytes += counterDelta(previous.rx, item.rxBytes);
      row.txBytes += counterDelta(previous.tx, item.txBytes);
    }
    return importRouterUsage(db, rows);
  }
  return { source: 'fallback' as const, ...await recordWanUsage(db, transport) };
}

export function loadWanUsage(db: Database.Database, today = utcDay()) {
  const since = (db.prepare('SELECT MIN(seen_at) AS since FROM wan_counter_state').get() as { since: string | null }).since;
  const routerImportedAt = (db.prepare("SELECT value FROM app_settings WHERE key = 'wanUsageRouterImportedAt'").get() as { value: string } | undefined)?.value ?? null;
  // O dia da instalação é parcial e mistura-se com a contagem antiga da app (MAX): só o seguinte
  // é exato. Antes disso, com a app fechada, o tráfego caía no dia da reabertura.
  const firstDay = (db.prepare("SELECT value FROM app_settings WHERE key = 'wanUsageRouterFirstDay'").get() as { value: string } | undefined)?.value;
  const exactSince = firstDay ? new Date(Date.parse(`${firstDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
  const dayRows = db.prepare(`SELECT interface, rx_bytes AS rxBytes, tx_bytes AS txBytes
    FROM wan_traffic_daily WHERE day = ? ORDER BY interface`).all(today) as UsageRow[];
  const monthRows = db.prepare(`SELECT interface, SUM(rx_bytes) AS rxBytes, SUM(tx_bytes) AS txBytes
    FROM wan_traffic_daily WHERE day >= ? AND day <= ? GROUP BY interface ORDER BY interface`)
    .all(`${today.slice(0, 7)}-01`, today) as UsageRow[];
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  const startDay = start.toISOString().slice(0, 10);
  const history = db.prepare(`SELECT day, interface, rx_bytes AS rxBytes, tx_bytes AS txBytes, source
    FROM wan_traffic_daily WHERE day >= ? AND day <= ? ORDER BY day, interface`)
    .all(startDay, today) as Array<{ day: string; interface: string; rxBytes: number; txBytes: number; source: WanUsageSource }>;
  const names = [...new Set((db.prepare('SELECT interface FROM wan_counter_state UNION SELECT interface FROM wan_traffic_daily').all() as Array<{ interface: string }>).map((row) => row.interface))].sort();
  const byDay = new Map<string, Map<string, { rxBytes: number; txBytes: number; source: WanUsageSource }>>();
  for (const row of history) {
    if (!byDay.has(row.day)) byDay.set(row.day, new Map());
    byDay.get(row.day)!.set(row.interface, { rxBytes: row.rxBytes, txBytes: row.txBytes, source: row.source });
  }
  const days = Array.from({ length: 30 }, (_, offset) => {
    const date = new Date(`${startDay}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const day = date.toISOString().slice(0, 10);
    return { day, perInterface: names.map((name) => {
      const row = byDay.get(day)?.get(name);
      return { interface: name, rxBytes: row?.rxBytes ?? 0, txBytes: row?.txBytes ?? 0, source: row?.source ?? 'counted' };
    }) };
  });
  return { since: since ?? (history[0]?.day ?? null), routerImportedAt, exactSince, today: dayRows, month: monthRows, days };
}
