import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';
import { createTransport, isRouterConfigured, readClientUsageData, readRouterConfig, type RouterTransport } from './routeros';
import { refreshUsageCounterForJob, usageCounterDisk } from './usage-counter';
import { counterDelta, utcDay } from './wan-usage';
import { cycleFor, cycleStartDay, dayInZone, loadFupUsage, stateFromEvents, usagePercent } from './fup';
import { bytesPerGb, globalCycleDay, readFupSettings } from './fup-settings';

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

/**
 * Consumo de cada serviço PPPoE no ciclo do uso justo: o mesmo "hoje" (fuso das
 * Definições) e o mesmo início de ciclo de loadFupUsage, para o total da tabela
 * bater com a percentagem ao lado.
 */
export function loadClientUsage(db: Database.Database, now = new Date()) {
  const settings = readFupSettings(db);
  const today = dayInZone(now, settings.fuso_horario);
  const globalDay = globalCycleDay(settings);
  const services = db.prepare(`SELECT s.id AS serviceId, s.status AS status, c.client_code AS clientCode, c.full_name AS clientName,
      COALESCE(p.name, 'Sem plano') AS plan, s.fup_cycle_day AS cycleDay, s.activation_date AS activationDate,
      COALESCE(d.tx_bytes, 0) AS todayDownBytes, COALESCE(d.rx_bytes, 0) AS todayUpBytes,
      EXISTS(SELECT 1 FROM client_usage_state st WHERE st.pppoe_name = s.pppoe_username) AS measured
    FROM services s JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    LEFT JOIN client_traffic_daily d ON d.service_id = s.id AND d.day = ?
    WHERE s.pppoe_username IS NOT NULL AND s.pppoe_username <> ''`).all(today) as Array<{
      serviceId: number; status: string; clientCode: string; clientName: string; plan: string;
      cycleDay: number | null; activationDate: string | null;
      todayDownBytes: number; todayUpBytes: number; measured: number;
    }>;
  const cycleUsage = db.prepare(`SELECT COUNT(*) AS days, COALESCE(SUM(tx_bytes), 0) AS down, COALESCE(SUM(rx_bytes), 0) AS up
    FROM client_traffic_daily WHERE service_id = ? AND day >= ? AND day <= ?`);
  return services
    .map(({ status, cycleDay, activationDate, ...row }) => {
      const cycle = cycleFor(today, cycleStartDay(cycleDay, activationDate, globalDay));
      const usage = cycleUsage.get(row.serviceId, cycle.start, cycle.end) as { days: number; down: number; up: number };
      return { ...row, cycleStart: cycle.start, cycleDownBytes: usage.down, cycleUpBytes: usage.up, keep: status === 'active' || usage.days > 0 };
    })
    .filter((row) => row.keep)
    .map(({ keep: _keep, ...row }) => row)
    .sort((a, b) => (b.cycleDownBytes + b.cycleUpBytes) - (a.cycleDownBytes + a.cycleUpBytes)
      || a.clientCode.localeCompare(b.clientCode) || a.serviceId - b.serviceId);
}

export type UsageCycle = {
  start: string; end: string; period: string; current: boolean;
  downBytes: number; upBytes: number; days: number; percent: number;
  fup: 'AVISO' | 'LIMITADO' | null;
};

/**
 * Consumo de um serviço ciclo a ciclo, do atual para trás, até ao primeiro dia medido
 * (no máximo `max` ciclos). O ciclo atual é o do uso justo, para a % bater certo.
 * ponytail: os ciclos passados usam o dia de início e a referência ATUAIS; se mudaram,
 * os antigos não coincidem com os de então (não se guarda o histórico desses valores).
 */
export function loadServiceUsageCycles(db: Database.Database, serviceId: number, now = new Date(), max = 24) {
  const settings = readFupSettings(db);
  const perGb = bytesPerGb(settings);
  const [service] = loadFupUsage(db, now, settings, { serviceId });
  const first = service
    ? (db.prepare('SELECT MIN(day) AS day FROM client_traffic_daily WHERE service_id = ?').get(serviceId) as { day: string | null }).day
    : null;
  if (!service || !first) {
    return { referenceGb: service?.referenceGb ?? 0, bytesPerGb: perGb, cycles: [] as UsageCycle[], daily: [] as UsageDay[], profile: null };
  }
  const usage = db.prepare(`SELECT COUNT(*) AS days, COALESCE(SUM(tx_bytes), 0) AS down, COALESCE(SUM(rx_bytes), 0) AS up
    FROM client_traffic_daily WHERE service_id = ? AND day >= ? AND day <= ?`);
  const events = db.prepare('SELECT kind FROM fup_events WHERE service_id = ? AND period = ?');
  const startDay = Number(service.cycle.start.slice(8, 10));
  const cycles: UsageCycle[] = [];
  let cycle: { start: string; end: string; period: string } = service.cycle;
  while (cycles.length < max && cycle.end >= first) {
    const { days, down, up } = usage.get(serviceId, cycle.start, cycle.end) as { days: number; down: number; up: number };
    const state = stateFromEvents((events.all(serviceId, cycle.period) as Array<{ kind: string }>).map((event) => event.kind));
    cycles.push({
      start: cycle.start, end: cycle.end, period: cycle.period, current: cycles.length === 0,
      downBytes: down, upBytes: up, days,
      percent: usagePercent(down + up, service.referenceGb, perGb),
      fup: state === 'LIMITADO' || state === 'AVISO' ? state : null
    });
    const previousDay = new Date(Date.UTC(Number(cycle.start.slice(0, 4)), Number(cycle.start.slice(5, 7)) - 1, startDay - 1)).toISOString().slice(0, 10);
    cycle = cycleFor(previousDay, startDay);
  }
  const today = dayInZone(now, settings.fuso_horario);
  const daily = db.prepare(`SELECT day, tx_bytes AS downBytes, rx_bytes AS upBytes FROM client_traffic_daily
    WHERE service_id = ? AND day >= ? ORDER BY day`).all(serviceId, shiftDay(today, -(DAILY_HISTORY_DAYS - 1))) as UsageDay[];
  const profile = {
    ...classifyAgainstBase(db, serviceId, today),
    overPlafond: overPlafond(cycles, service.referenceGb, today)
  };
  return { referenceGb: service.referenceGb, bytesPerGb: perGb, cycles, daily, profile };
}

export type UsageDay = { day: string; downBytes: number; upBytes: number };
export type UsageClass = 'LEVE' | 'MEDIO' | 'INTENSO' | 'MUITO_INTENSO' | 'SEM_DADOS';

/** Série diária devolvida ao ecrã (mês e ano agrupam-se lá): 24 meses. */
const DAILY_HISTORY_DAYS = 731;
/** Janela do perfil, mínimo de dias medidos por serviço e de serviços para comparar. */
export const PROFILE_WINDOW_DAYS = 90;
export const PROFILE_MIN_DAYS = 14;
export const PROFILE_MIN_PEERS = 8;

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Posição numa base (Sandvine/Nokia: percentis da própria rede). `percentile` = % dos outros
 * serviços com média diária abaixo desta. Leve <P25, Médio <P75, Intenso <P95, Muito intenso ≥P95.
 */
export function classifyAverage(peers: number[], mine: number): { percentile: number; klass: Exclude<UsageClass, 'SEM_DADOS'> } {
  const others = peers.length - 1;
  const below = peers.filter((value) => value < mine).length;
  const percentile = others > 0 ? Math.round((below / others) * 100) : 0;
  const klass = percentile >= 95 ? 'MUITO_INTENSO' : percentile >= 75 ? 'INTENSO' : percentile >= 25 ? 'MEDIO' : 'LEVE';
  return { percentile, klass };
}

/**
 * Média diária dos últimos 90 dias (só dias medidos: o ISPM fechado deixa buracos) de cada
 * serviço PPPoE ativo com pelo menos 14 dias medidos, e a classe deste serviço nessa base.
 * ponytail: recalcula a base a cada pedido (um GROUP BY sobre dezenas de serviços); cache diária se forem milhares.
 */
function classifyAgainstBase(db: Database.Database, serviceId: number, today: string) {
  const rows = db.prepare(`SELECT d.service_id AS serviceId, COUNT(*) AS days, SUM(d.tx_bytes + d.rx_bytes) AS total
    FROM client_traffic_daily d JOIN services s ON s.id = d.service_id
    WHERE s.status = 'active' AND s.pppoe_username IS NOT NULL AND TRIM(s.pppoe_username) <> '' AND d.day >= ? AND d.day <= ?
    GROUP BY d.service_id HAVING COUNT(*) >= ?`).all(shiftDay(today, -(PROFILE_WINDOW_DAYS - 1)), today, PROFILE_MIN_DAYS) as Array<{ serviceId: number; days: number; total: number }>;
  const own = rows.find((row) => row.serviceId === serviceId);
  const peers = rows.map((row) => row.total / row.days);
  if (!own || peers.length < PROFILE_MIN_PEERS) {
    return { avgDailyBytes: own ? own.total / own.days : null, percentile: null, klass: 'SEM_DADOS' as UsageClass, peers: peers.length };
  }
  const avgDailyBytes = own.total / own.days;
  return { avgDailyBytes, ...classifyAverage(peers, avgDailyBytes), peers: peers.length };
}

/** Acima do plafond: o último ciclo completo passou os 100%, ou o atual, projetado ao fim do ciclo, vai passar. */
export function overPlafond(cycles: UsageCycle[], referenceGb: number, today: string): boolean {
  if (referenceGb <= 0 || cycles.length === 0) return false;
  const [current, previous] = cycles;
  if (previous && previous.percent > 100) return true;
  const elapsed = Math.round((Date.parse(today) - Date.parse(current.start)) / 86_400_000) + 1;
  const length = Math.round((Date.parse(current.end) - Date.parse(current.start)) / 86_400_000) + 1;
  // Com menos de 7 dias de ciclo a projeção é ruído (um dia forte dá 300%).
  return current.percent > 100 || (elapsed >= 7 && (current.percent * length) / elapsed > 100);
}
