import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSqliteDatabase } from '../db/database';

export type UserRole = 'admin' | 'operator' | 'technician';

export type AuthenticatedUser = {
  id: number;
  username: string;
  fullName: string;
  role: UserRole;
};

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SCRYPT_KEY_LEN = 64;
const SCRYPT_SALT_BYTES = 16;
const TOKEN_VERSION = 1;

let cachedSecret: Buffer | null = null;

function loadSecret(): Buffer {
  if (cachedSecret) return cachedSecret;

  const db = getSqliteDatabase();
  const existing = db.prepare(`SELECT value FROM app_settings WHERE key = 'auth_secret'`).get() as
    | { value: string }
    | undefined;

  if (existing?.value) {
    cachedSecret = Buffer.from(existing.value, 'hex');
    return cachedSecret;
  }

  const next = randomBytes(48);
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('auth_secret', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(next.toString('hex'));
  cachedSecret = next;
  return cachedSecret;
}

export function resetAuthSecretCache(): void {
  cachedSecret = null;
}

export function hashPassword(plaintext: string): string {
  if (!plaintext || plaintext.length < 4) {
    throw new Error('Password too short');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(plaintext, salt, SCRYPT_KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(plaintext: string, stored: string): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = scryptSync(plaintext, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

export type TokenPayload = {
  v: number;
  uid: number;
  role: UserRole;
  iat: number;
  exp: number;
};

export function signToken(user: AuthenticatedUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    uid: user.id,
    role: user.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS
  };
  const payloadJson = Buffer.from(JSON.stringify(payload), 'utf8');
  const payloadB64 = base64UrlEncode(payloadJson);
  const sig = createHmac('sha256', loadSecret()).update(payloadB64).digest();
  return `${payloadB64}.${base64UrlEncode(sig)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = createHmac('sha256', loadSecret()).update(payloadB64).digest();
  let actualSig: Buffer;
  try {
    actualSig = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (actualSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(actualSig, expectedSig)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.v !== TOKEN_VERSION) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  return payload;
}

export function loadUserById(id: number): AuthenticatedUser | null {
  const db = getSqliteDatabase();
  const row = db.prepare(`
    SELECT id, username, full_name AS fullName, role, active
    FROM users
    WHERE id = ?
  `).get(id) as
    | { id: number; username: string; fullName: string; role: UserRole; active: number }
    | undefined;
  if (!row || row.active !== 1) return null;
  return { id: row.id, username: row.username, fullName: row.fullName, role: row.role };
}

export function authBypassed(): boolean {
  return process.env.ISPM_AUTH === 'off';
}

export function isSetupComplete(): boolean {
  const db = getSqliteDatabase();
  const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as { n: number };
  return row.n > 0;
}
