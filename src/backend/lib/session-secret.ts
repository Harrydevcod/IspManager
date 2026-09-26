import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LocalProtection } from './local-protection';

/**
 * Chave que assina as sessões. Não é uma credencial portátil: vive selada só
 * na proteção local e fica fora do cofre de propósito. Num restauro noutra
 * máquina recria-se — todos entram outra vez, e os hashes `scrypt` das
 * passwords continuam a validar.
 *
 * Sem proteção local (`npm run dev`) a assinatura é efémera: vale enquanto o
 * processo vive e nunca é gravada em claro.
 */
const KEY = 'auth_secret';
const SECRET_BYTES = 48;

export function loadSessionSecret(db: Database.Database, protection: LocalProtection): Buffer {
  if (!protection.available()) return randomBytes(SECRET_BYTES);

  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (row?.value.startsWith('enc:v1:')) {
    try {
      const secret = Buffer.from(protection.open(row.value), 'hex');
      if (secret.length === SECRET_BYTES) return secret;
    } catch {
      // Selada noutra máquina: recria-se abaixo.
    }
  }

  // Uma assinatura antiga em claro não se reaproveita: pode ter viajado em backups.
  const next = randomBytes(SECRET_BYTES);
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(KEY, protection.seal(next.toString('hex')));
  return next;
}
