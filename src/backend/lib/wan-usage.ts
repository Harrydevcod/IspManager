import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { createTransport, isRouterConfigured, listInterfaceListMembers, listInterfaces, readRouterConfig, type RouterTransport } from './routeros';

function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function counterDelta(last: number | null, current: number): number {
  if (last === null) return 0;
  return current >= last ? current - last : current;
}

type CounterState = { rxLast: number; txLast: number };
type UsageRow = { interface: string; rxBytes: number; txBytes: number };

export async function recordWanUsage(db: Database.Database, transport: RouterTransport, today = localDay()) {
  const names = new Set(await listInterfaceListMembers(transport, 'WAN'));
  const interfaces = (await listInterfaces(transport))
    .filter((item) => names.has(item.name) && item.rxBytes !== null && item.txBytes !== null);
  const state = db.prepare('SELECT rx_last AS rxLast, tx_last AS txLast FROM wan_counter_state WHERE interface = ?');
  const add = db.prepare(`
    INSERT INTO wan_traffic_daily (day, interface, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, interface) DO UPDATE SET
      rx_bytes = rx_bytes + excluded.rx_bytes,
      tx_bytes = tx_bytes + excluded.tx_bytes
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
      // ponytail: o tráfego enquanto o ISPM está fechado fica no dia da reabertura; os contadores do router não permitem reparti-lo por dias.
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
  return recordWanUsage(db, createTransport(config));
}

export function loadWanUsage(db: Database.Database, today = localDay()) {
  const since = (db.prepare('SELECT MIN(seen_at) AS since FROM wan_counter_state').get() as { since: string | null }).since;
  const dayRows = db.prepare(`SELECT interface, rx_bytes AS rxBytes, tx_bytes AS txBytes
    FROM wan_traffic_daily WHERE day = ? ORDER BY interface`).all(today) as UsageRow[];
  const monthRows = db.prepare(`SELECT interface, SUM(rx_bytes) AS rxBytes, SUM(tx_bytes) AS txBytes
    FROM wan_traffic_daily WHERE day >= ? AND day <= ? GROUP BY interface ORDER BY interface`)
    .all(`${today.slice(0, 7)}-01`, today) as UsageRow[];
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  const startDay = start.toISOString().slice(0, 10);
  const history = db.prepare(`SELECT day, interface, rx_bytes AS rxBytes
    FROM wan_traffic_daily WHERE day >= ? AND day <= ? ORDER BY day, interface`)
    .all(startDay, today) as Array<{ day: string; interface: string; rxBytes: number }>;
  const names = [...new Set((db.prepare('SELECT interface FROM wan_counter_state UNION SELECT interface FROM wan_traffic_daily').all() as Array<{ interface: string }>).map((row) => row.interface))].sort();
  const byDay = new Map<string, Map<string, number>>();
  for (const row of history) {
    if (!byDay.has(row.day)) byDay.set(row.day, new Map());
    byDay.get(row.day)!.set(row.interface, row.rxBytes);
  }
  const days = Array.from({ length: 30 }, (_, offset) => {
    const date = new Date(`${startDay}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const day = date.toISOString().slice(0, 10);
    return { day, perInterface: names.map((name) => ({ interface: name, rxBytes: byDay.get(day)?.get(name) ?? 0 })) };
  });
  return { since, today: dayRows, month: monthRows, days };
}
