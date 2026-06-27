import type Database from 'better-sqlite3';

/**
 * Brute-force protection for the login endpoint.
 *
 * Failures are counted per identifier within a rolling window. Once the
 * threshold is reached the identifier is locked, and each further failure
 * doubles the lock duration up to a cap — classic exponential backoff. State is
 * persisted in `login_throttle` (see migration 0022) so a process restart does
 * not reset an attacker's progress.
 *
 * The login handler keys two identifiers per attempt — `user:<username>` and
 * `ip:<address>` — so a single account under attack locks before unrelated
 * accounts are affected, while a single source spraying many usernames still
 * gets throttled globally.
 */

/** Consecutive failures tolerated before the first lockout kicks in. */
export const MAX_ATTEMPTS = 5;
/** First lockout duration once the threshold is crossed. */
export const BASE_LOCK_MS = 60_000; // 1 minute
/** Ceiling for the exponential backoff. */
export const MAX_LOCK_MS = 15 * 60_000; // 15 minutes
/**
 * How long a failure stays "fresh". A gap longer than this between failures
 * resets the counter, so an honest user who fat-fingers a password once a day
 * never accumulates toward a lockout.
 */
export const ATTEMPT_WINDOW_MS = 15 * 60_000; // 15 minutes

type ThrottleRow = {
  identifier: string;
  fail_count: number;
  first_failed_at: string;
  last_failed_at: string;
  locked_until: string | null;
};

/** SQLite stores timestamps as `YYYY-MM-DD HH:MM:SS` in UTC (datetime('now')). */
function toSqlite(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlite(value: string | null): number {
  if (!value) return NaN;
  // Stored values are UTC without a zone marker; make that explicit for Date.
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

export type LockState = {
  locked: boolean;
  /** Seconds until the soonest unlock among the checked identifiers. */
  retryAfterSeconds: number;
};

/**
 * Is any of these identifiers currently locked? Returns the longest remaining
 * lock so the caller can advertise an accurate `Retry-After`.
 */
export function assessLogin(db: Database.Database, identifiers: string[], now: Date): LockState {
  const nowMs = now.getTime();
  let retryAfterSeconds = 0;
  const stmt = db.prepare('SELECT locked_until FROM login_throttle WHERE identifier = ?');
  for (const identifier of identifiers) {
    const row = stmt.get(identifier) as { locked_until: string | null } | undefined;
    const lockedUntil = parseSqlite(row?.locked_until ?? null);
    if (Number.isFinite(lockedUntil) && lockedUntil > nowMs) {
      retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((lockedUntil - nowMs) / 1000));
    }
  }
  return { locked: retryAfterSeconds > 0, retryAfterSeconds };
}

export type FailureResult = {
  failCount: number;
  lockedUntilMs: number | null;
};

/**
 * Record one failed attempt for an identifier and return the new state. If the
 * running count reaches {@link MAX_ATTEMPTS}, sets an exponentially growing
 * lock. Idempotent with respect to the window: stale rows restart the count.
 */
export function registerFailure(db: Database.Database, identifier: string, now: Date): FailureResult {
  const nowMs = now.getTime();
  const existing = db
    .prepare('SELECT * FROM login_throttle WHERE identifier = ?')
    .get(identifier) as ThrottleRow | undefined;

  const lastMs = parseSqlite(existing?.last_failed_at ?? null);
  const withinWindow = existing && Number.isFinite(lastMs) && nowMs - lastMs <= ATTEMPT_WINDOW_MS;

  const failCount = withinWindow ? existing!.fail_count + 1 : 1;
  const firstFailedAt = withinWindow ? existing!.first_failed_at : toSqlite(now);

  let lockedUntilMs: number | null = null;
  if (failCount >= MAX_ATTEMPTS) {
    const over = failCount - MAX_ATTEMPTS; // 0 on the attempt that first locks
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS);
    lockedUntilMs = nowMs + lockMs;
  }

  db.prepare(`
    INSERT INTO login_throttle (identifier, fail_count, first_failed_at, last_failed_at, locked_until)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(identifier) DO UPDATE SET
      fail_count = excluded.fail_count,
      first_failed_at = excluded.first_failed_at,
      last_failed_at = excluded.last_failed_at,
      locked_until = excluded.locked_until
  `).run(
    identifier,
    failCount,
    firstFailedAt,
    toSqlite(now),
    lockedUntilMs == null ? null : toSqlite(new Date(lockedUntilMs))
  );

  return { failCount, lockedUntilMs };
}

/** Clear throttle state for identifiers after a successful authentication. */
export function clearThrottle(db: Database.Database, identifiers: string[]): void {
  const stmt = db.prepare('DELETE FROM login_throttle WHERE identifier = ?');
  for (const identifier of identifiers) {
    stmt.run(identifier);
  }
}

/** Build the canonical identifiers a login attempt throttles against. */
export function loginIdentifiers(username: string, ip: string): string[] {
  return [`user:${username.trim().toLowerCase()}`, `ip:${ip}`];
}
