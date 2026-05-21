import { getSqliteDatabase } from '../db/database';
import { generateMonthlyBilling } from './billing';

const LAST_RUN_KEY = 'lastAutoBillingMonth';
const DEFAULT_DUE_DAY = 1;

function currentMonthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function readSetting(key: string): string | null {
  const db = getSqliteDatabase();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  const db = getSqliteDatabase();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export type AutoBillingResult =
  | { skipped: true; reason: string }
  | { ran: true; referenceMonth: string; created: number; activeServices: number };

/**
 * Auto-generates the current month's billing if:
 *  - today's day-of-month is >= the configured `defaultDueDay`, AND
 *  - this month hasn't been auto-billed yet (tracked in `lastAutoBillingMonth`).
 *
 * Idempotent — uses the same insert path as the manual endpoint, which is
 * itself idempotent per (service_id, reference_month). Safe to call on every
 * backend boot.
 */
export function runMonthlyBillingIfDue(now: Date = new Date()): AutoBillingResult {
  const dueDayRaw = readSetting('defaultDueDay');
  const dueDay = Number(dueDayRaw) > 0 ? Number(dueDayRaw) : DEFAULT_DUE_DAY;
  const today = now.getDate();

  if (today < dueDay) {
    return { skipped: true, reason: `dia ${today} ainda nao atingiu dueDay ${dueDay}` };
  }

  const refMonth = currentMonthKey(now);
  const lastRun = readSetting(LAST_RUN_KEY);
  if (lastRun === refMonth) {
    return { skipped: true, reason: `faturacao automatica de ${refMonth} ja executada` };
  }

  const db = getSqliteDatabase();
  const result = generateMonthlyBilling(db, refMonth);
  writeSetting(LAST_RUN_KEY, refMonth);

  return {
    ran: true,
    referenceMonth: refMonth,
    created: result.created,
    activeServices: result.activeServices
  };
}
