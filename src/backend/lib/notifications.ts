import type { Database } from 'better-sqlite3';

/**
 * O histórico do sino, comum ao PC e ao telemóvel.
 *
 * Uma entrada nasce de um facto que já ficou gravado noutro sítio (a sonda, o
 * outbox, um job) — aqui guarda-se só o que o sino mostra. O `uid` é ao mesmo
 * tempo a identidade partilhada com a app Android e a chave que impede
 * duplicados: o mesmo facto nunca entra duas vezes.
 *
 * Lida e "visto até" são por utilizador. O telemóvel não tem utilizadores, por
 * isso lê como o administrador que confirmou o pareamento (`companionUserId`).
 */

export type NotificationSeverity = 'info' | 'warn' | 'danger';
export type NotificationOrigin = 'pc' | 'phone';

export type NotificationInput = {
  uid: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  detail?: string | null;
  section?: string | null;
  focus?: string | null;
  origin?: NotificationOrigin;
  /** Quando o facto aconteceu; por omissão, agora. */
  createdAt?: string | null;
};

export type NotificationRow = {
  id: number;
  uid: string;
  origin: NotificationOrigin;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  detail: string | null;
  section: string | null;
  focus: string | null;
  createdAt: string;
  read: boolean;
};

/** Quantas entradas o sino mostra, e quantas vão no snapshot do telemóvel. */
export const NOTIFICATION_HISTORY_LIMIT = 100;
const KEEP_DAYS = 90;

/**
 * Houve mudança desde o último snapshot enviado ao telemóvel.
 *
 * Estado do processo, não da base: perdê-lo num reinício só antecipa um envio.
 * Vive aqui — e não em `companion-sync` — para os produtores o poderem ligar
 * sem importar o módulo da sincronização (seria uma dependência em círculo).
 */
let dirty = false;
export function notificationsChanged(): boolean { return dirty; }
export function clearNotificationsChanged() { dirty = false; }

/**
 * Grava uma notificação. Devolve o id, ou `null` se o `uid` já existia —
 * chamar duas vezes pelo mesmo facto não duplica nada.
 */
export function recordNotification(db: Database, input: NotificationInput): number | null {
  const result = db.prepare(`
    INSERT OR IGNORE INTO notifications (uid, origin, kind, severity, title, detail, section, focus, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    input.uid,
    input.origin ?? 'pc',
    input.kind,
    input.severity,
    input.title,
    input.detail ?? null,
    input.section ?? null,
    input.focus ?? null,
    input.createdAt ?? null
  );
  if (result.changes === 0) return null;
  dirty = true;
  return Number(result.lastInsertRowid);
}

/** As últimas entradas, da mais recente para a mais antiga, com o lido deste utilizador. */
export function listNotifications(db: Database, userId: number | null, limit = NOTIFICATION_HISTORY_LIMIT): NotificationRow[] {
  const rows = db.prepare(`
    SELECT n.id, n.uid, n.origin, n.kind, n.severity, n.title, n.detail, n.section, n.focus,
           n.created_at AS createdAt, r.read_at AS readAt
    FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ?
  `).all(userId ?? -1, limit) as Array<Omit<NotificationRow, 'read'> & { readAt: string | null }>;
  return rows.map(({ readAt, ...row }) => ({ ...row, read: readAt !== null }));
}

/** Entradas nascidas depois da última vez que este utilizador abriu o sino. */
export function unseenNotificationCount(db: Database, userId: number | null): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM notifications
    WHERE created_at > COALESCE((SELECT seen_at FROM notification_seen WHERE user_id = ?), '')
  `).get(userId ?? -1) as { n: number };
  return row.n;
}

export function markNotificationRead(db: Database, userId: number, notificationId: number, at = nowIso()): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO notification_reads (user_id, notification_id, read_at) VALUES (?, ?, ?)
  `).run(userId, notificationId, at);
  if (result.changes > 0) dirty = true;
  return result.changes > 0;
}

/** Marca como lida pelo id partilhado com o telemóvel. Um `uid` que não exista ignora-se. */
export function markNotificationReadByUid(db: Database, userId: number, uid: string, at = nowIso()): boolean {
  const row = db.prepare('SELECT id FROM notifications WHERE uid = ?').get(uid) as { id: number } | undefined;
  return row ? markNotificationRead(db, userId, row.id, at) : false;
}

export function markAllNotificationsRead(db: Database, userId: number, at = nowIso()): number {
  const result = db.prepare(`
    INSERT OR IGNORE INTO notification_reads (user_id, notification_id, read_at)
    SELECT ?, id, ? FROM notifications
  `).run(userId, at);
  if (result.changes > 0) dirty = true;
  return result.changes;
}

/** "Visto até" nunca recua: fica sempre com o maior dos dois valores. */
export function markNotificationsSeen(db: Database, userId: number, at = nowIso()) {
  db.prepare(`
    INSERT INTO notification_seen (user_id, seen_at) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)
  `).run(userId, at);
  dirty = true;
}

export function notificationsSeenAt(db: Database, userId: number | null): string | null {
  const row = db.prepare('SELECT seen_at AS seenAt FROM notification_seen WHERE user_id = ?').get(userId ?? -1) as { seenAt: string } | undefined;
  return row?.seenAt ?? null;
}

/** Limpeza diária: o sino não é um arquivo. */
export function pruneNotifications(db: Database, days = KEEP_DAYS): number {
  return db.prepare(`DELETE FROM notifications WHERE created_at < datetime('now', '-${days} days')`).run().changes;
}

/**
 * Quem o telemóvel representa ao ler uma notificação: o administrador que
 * confirmou o pareamento. Nos pareamentos antigos, o primeiro admin ativo.
 */
export function companionUserId(db: Database): number | null {
  const saved = db.prepare("SELECT value FROM app_settings WHERE key = 'smsCompanionUserId'").get() as { value: string } | undefined;
  const id = Number(saved?.value);
  if (Number.isInteger(id) && id > 0 && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return id;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  return admin?.id ?? null;
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
