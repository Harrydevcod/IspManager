import { getSqliteDatabase } from '../db/database';
import { businessDay } from '../../shared/business-day';
import { loadUpcomingSuspensions } from './auto-suspension';
import { pruneNotifications, recordNotification } from './notifications';

/**
 * A passagem diária do sino: limpa o que já não interessa e avisa das
 * suspensões a chegar.
 *
 * O aviso é um por dia — o cálculo das suspensões não muda de hora a hora, e
 * repeti-lo a cada tick enchia o sino do mesmo.
 */

const DAY_KEY = 'notificationsDailyDay';

export type NotificationsDailyRun =
  | { skipped: true; reason: string }
  | { pruned: number; upcoming: number };

export function runNotificationsDailyIfDue(now: Date = new Date()): NotificationsDailyRun {
  const db = getSqliteDatabase();
  const today = businessDay(now);
  const last = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DAY_KEY) as { value: string } | undefined;
  if (last?.value === today) return { skipped: true, reason: 'já corrido hoje' };
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(DAY_KEY, today);

  const pruned = pruneNotifications(db);
  const upcoming = loadUpcomingSuspensions(db);
  if (upcoming.length > 0) {
    recordNotification(db, {
      uid: `suspensions:${today}`,
      kind: 'suspensions_upcoming',
      severity: 'warn',
      title: `${upcoming.length} ${upcoming.length === 1 ? 'suspensão' : 'suspensões'} nos próximos 7 dias`,
      detail: null,
      section: 'finance',
      focus: 'overdue'
    });
  }
  return { pruned, upcoming: upcoming.length };
}
