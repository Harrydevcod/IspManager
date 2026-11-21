import { getSqliteDatabase } from '../db/database';
import { businessDay } from '../../shared/business-day';
import { loadUpcomingSuspensions } from './auto-suspension';
import { classDrops } from './payment-behaviour';
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
  | { pruned: number; upcoming: number; drops: number };

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
  // Quem desceu de classe no último mês. O uid leva o cliente e o mês, para o
  // mesmo cliente não encher o sino todos os dias com a mesma descida.
  const drops = classDrops(db, today);
  for (const drop of drops) {
    recordNotification(db, {
      uid: `behaviour:${drop.clientId}:${today.slice(0, 7)}`,
      kind: 'behaviour_drop',
      severity: 'warn',
      title: `${drop.clientName} desceu de ${drop.from} para ${drop.to}`,
      detail: 'Comportamento de pagamento no último mês.',
      section: 'finance',
      focus: 'behaviour'
    });
  }

  return { pruned, upcoming: upcoming.length, drops: drops.length };
}
