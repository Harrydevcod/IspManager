import type Database from 'better-sqlite3';
import { outageNoticeSendingAllowed } from '../../shared/business-day';

/** A fila só pode despachar avisos enquanto o operador mantém a sonda e os avisos ativos. */
export function outageDispatchAllowed(db: Database.Database, now: Date): boolean {
  if (!outageNoticeSendingAllowed(now)) return false;
  const row = db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key IN ('networkProbeEnabled', 'outageNoticesEnabled') AND value = 'true'").get() as { n: number };
  return row.n === 2;
}
