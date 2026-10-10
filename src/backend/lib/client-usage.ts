import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import { createTransport, isRouterConfigured, readClientUsageData, readRouterConfig, type RouterTransport } from './routeros';
import { refreshUsageCounterForJob, usageCounterDisk } from './usage-counter';
import { counterDelta, utcDay } from './wan-usage';

export type ClientUsageCounter = { name: string; rxTotal: number; txTotal: number; rxLast: number; txLast: number; uptime: string };

export function parseClientUsageFile(text: string): ClientUsageCounter[] {
  const rows = new Map<string, ClientUsageCounter>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.replace(/^# /, '').split(';');
    if (parts.length !== 6 || !parts[0] || !parts[5] || !parts.slice(1, 5).every((part) => /^\d+$/.test(part))) continue;
    const numbers = parts.slice(1, 5).map(Number);
    if (!numbers.every(Number.isSafeInteger)) continue;
    rows.set(parts[0], { name: parts[0], rxTotal: numbers[0], txTotal: numbers[1], rxLast: numbers[2], txLast: numbers[3], uptime: parts[5] });
  }
  return [...rows.values()];
}

export async function collectClientUsage(db: Database.Database, transport: RouterTransport, today = utcDay()) {
  const data = await readClientUsageData(transport, usageCounterDisk(db, 'client'));
  const rows = parseClientUsageFile(data ?? '');
  const state = db.prepare('SELECT rx_total AS rxTotal, tx_total AS txTotal FROM client_usage_state WHERE pppoe_name = ?');
  const service = db.prepare("SELECT id FROM services WHERE pppoe_username = ? ORDER BY status = 'active' DESC, id DESC LIMIT 1");
  const add = db.prepare(`INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, service_id) DO UPDATE SET rx_bytes = rx_bytes + excluded.rx_bytes, tx_bytes = tx_bytes + excluded.tx_bytes`);
  const save = db.prepare(`INSERT INTO client_usage_state (pppoe_name, rx_total, tx_total, seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(pppoe_name) DO UPDATE SET rx_total = excluded.rx_total, tx_total = excluded.tx_total, seen_at = excluded.seen_at`);
  const seenAt = new Date().toISOString();
  return db.transaction(() => {
    let imported = 0;
    for (const row of rows) {
      const previous = state.get(row.name) as { rxTotal: number; txTotal: number } | undefined;
      const rx = counterDelta(previous?.rxTotal ?? null, row.rxTotal);
      const tx = counterDelta(previous?.txTotal ?? null, row.txTotal);
      const match = service.get(row.name) as { id: number } | undefined;
      if (match && (rx || tx)) {
        // Na interface PPPoE do servidor, tx-byte é download e rx-byte é upload; confirmar no router real.
        add.run(today, match.id, rx, tx);
        imported++;
      }
      save.run(row.name, row.rxTotal, row.txTotal, seenAt);
    }
    return { rows: rows.length, imported };
  })();
}

export async function runClientUsageIfDue() {
  const db = getSqliteDatabase();
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) return { skipped: true, reason: 'Router desligado ou por configurar' };
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { skipped: true, reason: offNetworkReason(presence) };
  const transport = createTransport(config);
  // Um contador já instalado numa versão antiga atualiza-se aqui; se falhar, conta-se na mesma.
  const installed = db.prepare('SELECT 1 FROM client_usage_state LIMIT 1').get() !== undefined;
  const counter = config.dryRun ? {} : await refreshUsageCounterForJob(db, transport, 'client', installed);
  return { ...await collectClientUsage(db, transport), ...counter };
}

export function loadClientUsage(db: Database.Database, today = utcDay()) {
  return db.prepare(`SELECT s.id AS serviceId, c.client_code AS clientCode, c.full_name AS clientName,
      COALESCE(p.name, 'Sem plano') AS plan,
      COALESCE(d.tx_bytes, 0) AS todayDownBytes, COALESCE(d.rx_bytes, 0) AS todayUpBytes,
      COALESCE(m.tx_bytes, 0) AS monthDownBytes, COALESCE(m.rx_bytes, 0) AS monthUpBytes,
      EXISTS(SELECT 1 FROM client_usage_state st WHERE st.pppoe_name = s.pppoe_username) AS measured
    FROM services s JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    LEFT JOIN client_traffic_daily d ON d.service_id = s.id AND d.day = ?
    LEFT JOIN (SELECT service_id, SUM(rx_bytes) AS rx_bytes, SUM(tx_bytes) AS tx_bytes
      FROM client_traffic_daily WHERE day >= ? AND day <= ? GROUP BY service_id) m ON m.service_id = s.id
    WHERE (s.status = 'active' OR m.service_id IS NOT NULL) AND s.pppoe_username IS NOT NULL AND s.pppoe_username <> ''
    ORDER BY monthDownBytes + monthUpBytes DESC, c.client_code, s.id`)
    .all(today, `${today.slice(0, 7)}-01`, today) as Array<{
      serviceId: number; clientCode: string; clientName: string; plan: string;
      todayDownBytes: number; todayUpBytes: number; monthDownBytes: number; monthUpBytes: number; measured: number;
    }>;
}
