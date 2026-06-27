import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import {
  assessLogin,
  clearThrottle,
  loginIdentifiers,
  registerFailure,
  BASE_LOCK_MS,
  MAX_ATTEMPTS,
  MAX_LOCK_MS,
  ATTEMPT_WINDOW_MS
} from './login-throttle';

let db: Database.Database;

const T0 = new Date('2026-06-26T10:00:00Z');
const at = (msOffset: number) => new Date(T0.getTime() + msOffset);
const ID = 'user:admin';

beforeEach(() => {
  db = new Database(':memory:');
  // Mirror migration 0022 so the unit is exercised against the real shape.
  db.exec(`
    CREATE TABLE login_throttle (
      identifier TEXT PRIMARY KEY,
      fail_count INTEGER NOT NULL DEFAULT 0,
      first_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      locked_until TEXT
    );
  `);
});

describe('login-throttle', () => {
  test('counts failures and stays unlocked below the threshold', () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = registerFailure(db, ID, at(i * 1000));
      expect(r.failCount).toBe(i);
      expect(r.lockedUntilMs).toBeNull();
    }
    expect(assessLogin(db, [ID], at(MAX_ATTEMPTS * 1000)).locked).toBe(false);
  });

  test('locks on the threshold failure for the base duration', () => {
    let last = registerFailure(db, ID, T0);
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      last = registerFailure(db, ID, at(i * 1000));
    }
    expect(last.failCount).toBe(MAX_ATTEMPTS);
    expect(last.lockedUntilMs).toBe(at(MAX_ATTEMPTS * 1000).getTime() + BASE_LOCK_MS);

    const state = assessLogin(db, [ID], at(MAX_ATTEMPTS * 1000 + 1000));
    expect(state.locked).toBe(true);
    expect(state.retryAfterSeconds).toBe(BASE_LOCK_MS / 1000 - 1);
  });

  test('escalates the lock exponentially on further failures', () => {
    for (let i = 1; i <= MAX_ATTEMPTS; i++) registerFailure(db, ID, at(i * 1000));
    // Lock expired; the next failure (6th) is still inside the window → doubles.
    const sixth = registerFailure(db, ID, at(MAX_ATTEMPTS * 1000 + BASE_LOCK_MS + 1000));
    expect(sixth.failCount).toBe(MAX_ATTEMPTS + 1);
    expect(sixth.lockedUntilMs).toBe(at(MAX_ATTEMPTS * 1000 + BASE_LOCK_MS + 1000).getTime() + BASE_LOCK_MS * 2);
  });

  test('caps the lockout at MAX_LOCK_MS', () => {
    let last = registerFailure(db, ID, T0);
    // Keep failing within the window until well past the cap.
    for (let i = 1; i < 10; i++) {
      last = registerFailure(db, ID, at(i * 1000));
    }
    expect(last.failCount).toBe(10);
    expect(last.lockedUntilMs).toBe(at(9 * 1000).getTime() + MAX_LOCK_MS);
  });

  test('resets the counter after the attempt window elapses', () => {
    registerFailure(db, ID, T0);
    registerFailure(db, ID, at(1000));
    const stale = registerFailure(db, ID, at(ATTEMPT_WINDOW_MS + 2000));
    expect(stale.failCount).toBe(1);
    expect(stale.lockedUntilMs).toBeNull();
  });

  test('assessLogin reports unlocked once the lock expires', () => {
    for (let i = 1; i <= MAX_ATTEMPTS; i++) registerFailure(db, ID, at(i * 1000));
    const lockedAtMs = at(MAX_ATTEMPTS * 1000).getTime() + BASE_LOCK_MS;
    expect(assessLogin(db, [ID], new Date(lockedAtMs - 1000)).locked).toBe(true);
    expect(assessLogin(db, [ID], new Date(lockedAtMs + 1000)).locked).toBe(false);
  });

  test('assessLogin returns the longest remaining lock across identifiers', () => {
    const [userId, ipId] = ['user:a', 'ip:1.2.3.4'];
    for (let i = 1; i <= MAX_ATTEMPTS; i++) registerFailure(db, userId, at(i * 1000));
    // ip locks later and therefore longer-remaining at the probe time.
    for (let i = 1; i <= MAX_ATTEMPTS; i++) registerFailure(db, ipId, at(i * 1000 + 5000));
    const probe = at(MAX_ATTEMPTS * 1000 + 6000);
    const state = assessLogin(db, [userId, ipId], probe);
    expect(state.locked).toBe(true);
    // ip unlock is 5s later than user unlock → its retryAfter wins.
    const ipUnlock = at(MAX_ATTEMPTS * 1000 + 5000).getTime() + BASE_LOCK_MS;
    expect(state.retryAfterSeconds).toBe(Math.ceil((ipUnlock - probe.getTime()) / 1000));
  });

  test('clearThrottle wipes state so the counter restarts', () => {
    for (let i = 1; i <= MAX_ATTEMPTS; i++) registerFailure(db, ID, at(i * 1000));
    expect(assessLogin(db, [ID], at(MAX_ATTEMPTS * 1000 + 1000)).locked).toBe(true);

    clearThrottle(db, [ID]);
    expect(assessLogin(db, [ID], at(MAX_ATTEMPTS * 1000 + 1000)).locked).toBe(false);

    const fresh = registerFailure(db, ID, at(100_000));
    expect(fresh.failCount).toBe(1);
  });

  test('loginIdentifiers normalizes the username and pairs it with the IP', () => {
    expect(loginIdentifiers('  Admin ', '127.0.0.1')).toEqual(['user:admin', 'ip:127.0.0.1']);
  });
});
