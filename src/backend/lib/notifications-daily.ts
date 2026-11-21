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
  // Quantos desceram de classe, e não quem: o histórico do sino não é filtrado
  // por papel (só o `now` é), e sincroniza com o telemóvel. Um nome com a
  // classe de pagamento ao lado é informação financeira de um cliente, e fica
  // atrás de `/api/finance/payment-behaviour`, que exige admin ou operador.
  // É também o que a suspensão a chegar já faz, uma linha acima.
  const drops = classDrops(db, today);
  if (drops.length > 0) {
    recordNotification(db, {
      uid: `behaviour-drops:${today}`,
      kind: 'behaviour_drop',
      severity: 'warn',
      title: `${drops.length} ${drops.length === 1 ? 'cliente desceu' : 'clientes desceram'} de classe`,
      detail: null,
      section: 'finance',
      focus: 'behaviour'
    });
  }

  return { pruned, upcoming: upcoming.length, drops: drops.length };
}
