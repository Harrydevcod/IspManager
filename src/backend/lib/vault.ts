import { hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LocalProtection } from './local-protection';
import { decryptValue, encryptValue } from './vault-crypto';

/**
 * Cofre de credenciais. Uma chave de dados (32 B) cifra os segredos
 * persistidos; ela própria vive embrulhada duas vezes em `credential_vault`:
 *
 * - `local_wrapped_key` — pela proteção local (DPAPI). Não viaja com o ficheiro.
 * - `recovery_wrapped_key` — por uma chave derivada da chave de recuperação,
 *   que o administrador guarda. É o que abre o cofre noutra máquina.
 *
 * Estados: `absent` (não há cofre e esta sessão não o pode criar — D3),
 * `recovery_pending` (aberto, chave de recuperação ainda por confirmar),
 * `ready`, `locked` (há cofre mas a proteção local não o abre — D4).
 * Nada aqui apaga ou recria um cofre existente.
 */
export type VaultStatus = 'ready' | 'recovery_pending' | 'locked' | 'absent';

export interface Vault {
  status(): VaultStatus;
  encrypt(context: string, value: string): string;
  decrypt(context: string, stored: string): string;
  pendingRecoveryKey(): string;
  confirmRecovery(key: string): void;
  unlock(key: string): void;
  dispose(): void;
}

interface VaultRow {
  vault_id: string;
  local_wrapped_key: string;
  recovery_wrapped_key: string;
  pending_recovery_local: string | null;
  recovery_confirmed_at: string | null;
}

const RECOVERY_CONTEXT = 'credential_vault.recovery_wrapped_key';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Buffer): string {
  let bits = 0, acc = 0, out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/** `ISPM-XXXX-…` (13 grupos). Aceita minúsculas, espaços e hífenes à vontade. */
function formatRecoveryKey(raw: Buffer): string {
  return 'ISPM-' + base32(raw).match(/.{4}/g)!.join('-');
}

function normalizeRecoveryKey(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/^ISPM/, '');
}

function parseRecoveryKey(input: string): Buffer {
  const text = normalizeRecoveryKey(input);
  if (!/^[A-Z2-7]{52}$/.test(text)) throw new Error('RECOVERY_KEY_INVALID');
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const ch of text) {
    acc = (acc << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; }
  }
  const raw = Buffer.from(out);
  // Só a forma canónica: os 4 bits de enchimento têm de ser zero.
  if (raw.length !== 32 || base32(raw) !== text) throw new Error('RECOVERY_KEY_INVALID');
  return raw;
}

// A chave de recuperação tem 256 bits de entropia: HKDF chega, não é uma password.
function recoveryWrapKey(raw: Buffer, vaultId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', raw, vaultId, 'ispm-vault-recovery-v1', 32));
}

function hasOrphanCiphertext(db: Database.Database): boolean {
  return !!db.prepare(`
    SELECT 1 FROM app_settings WHERE value LIKE 'enc:v2:%'
    UNION ALL SELECT 1 FROM services WHERE pppoe_password LIKE 'enc:v2:%'
    LIMIT 1
  `).get();
}

function readRow(db: Database.Database): VaultRow | undefined {
  return db.prepare(`
    SELECT vault_id, local_wrapped_key, recovery_wrapped_key, pending_recovery_local, recovery_confirmed_at
    FROM credential_vault WHERE id = 1
  `).get() as VaultRow | undefined;
}

function createVault(db: Database.Database, protection: LocalProtection): Buffer {
  const dataKey = randomBytes(32);
  const recoveryRaw = randomBytes(32);
  const vaultId = randomUUID();
  const row: VaultRow = {
    vault_id: vaultId,
    local_wrapped_key: protection.seal(dataKey.toString('base64')),
    recovery_wrapped_key: encryptValue(recoveryWrapKey(recoveryRaw, vaultId), RECOVERY_CONTEXT, dataKey.toString('base64')),
    pending_recovery_local: protection.seal(formatRecoveryKey(recoveryRaw)),
    recovery_confirmed_at: null
  };
  // Só persiste depois de provar que os dois invólucros reabrem.
  const viaLocal = Buffer.from(protection.open(row.local_wrapped_key), 'base64');
  const viaRecovery = Buffer.from(decryptValue(recoveryWrapKey(recoveryRaw, vaultId), RECOVERY_CONTEXT, row.recovery_wrapped_key), 'base64');
  if (!viaLocal.equals(dataKey) || !viaRecovery.equals(dataKey)) throw new Error('VAULT_CREATE_VERIFY_FAILED');
  db.prepare(`
    INSERT INTO credential_vault (id, vault_id, local_wrapped_key, recovery_wrapped_key, pending_recovery_local)
    VALUES (1, @vault_id, @local_wrapped_key, @recovery_wrapped_key, @pending_recovery_local)
  `).run(row);
  return dataKey;
}

export function openVault(db: Database.Database, protection: LocalProtection): Vault {
  let dataKey: Buffer | null = null;
  let disposed = false;
  let current: VaultStatus;

  let row = readRow(db);
  if (!row && protection.available() && !hasOrphanCiphertext(db)) {
    dataKey = db.transaction(() => (readRow(db) ? null : createVault(db, protection)))();
    if (!dataKey) row = readRow(db); // outro processo criou-o entretanto
  }

  if (dataKey) {
    current = 'recovery_pending';
  } else if (!row) {
    // Sem cofre: ou não o podemos criar (D3), ou já há ciphertext órfão e recriar perdê-lo-ia.
    current = protection.available() ? 'locked' : 'absent';
  } else {
    try {
      if (!protection.available()) throw new Error('LOCAL_PROTECTION_UNAVAILABLE');
      dataKey = Buffer.from(protection.open(row.local_wrapped_key), 'base64');
      if (dataKey.length !== 32) throw new Error('INVALID_LOCAL_ENVELOPE');
      current = row.recovery_confirmed_at ? 'ready' : 'recovery_pending';
    } catch {
      dataKey = null;
      current = 'locked';
    }
  }

  function alive() {
    if (disposed) throw new Error('VAULT_DISPOSED');
  }

  function key(): Buffer {
    alive();
    if (dataKey) return dataKey;
    throw new Error(current === 'locked' ? 'VAULT_LOCKED' : 'VAULT_UNAVAILABLE');
  }

  function pendingKey(): string {
    alive();
    const sealed = current === 'recovery_pending' ? readRow(db)?.pending_recovery_local : null;
    if (!sealed) throw new Error('NO_PENDING_RECOVERY');
    return protection.open(sealed);
  }

  return {
    status() {
      alive();
      return current;
    },
    encrypt(context, value) {
      return encryptValue(key(), context, value);
    },
    decrypt(context, stored) {
      return decryptValue(key(), context, stored);
    },
    pendingRecoveryKey: pendingKey,
    confirmRecovery(input) {
      const expected = Buffer.from(normalizeRecoveryKey(pendingKey()));
      const given = Buffer.from(normalizeRecoveryKey(input));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('RECOVERY_KEY_MISMATCH');
      db.prepare(`
        UPDATE credential_vault SET pending_recovery_local = NULL, recovery_confirmed_at = CURRENT_TIMESTAMP WHERE id = 1
      `).run();
      current = 'ready';
    },
    unlock(input) {
      alive();
      if (current !== 'locked') throw new Error('VAULT_NOT_LOCKED');
      const stored = readRow(db);
      if (!stored) throw new Error('VAULT_METADATA_MISSING');
      let recovered: Buffer;
      try {
        const wrapKey = recoveryWrapKey(parseRecoveryKey(input), stored.vault_id);
        recovered = Buffer.from(decryptValue(wrapKey, RECOVERY_CONTEXT, stored.recovery_wrapped_key), 'base64');
        if (recovered.length !== 32) throw new Error('INVALID');
      } catch {
        throw new Error('RECOVERY_KEY_INVALID');
      }
      // Com proteção local, reembrulha para esta máquina: o próximo arranque abre sozinho.
      // Sem ela (npm run dev), o desbloqueio vive só em memória — nada é escrito.
      if (protection.available()) {
        db.prepare(`
          UPDATE credential_vault
          SET local_wrapped_key = ?, pending_recovery_local = NULL,
              recovery_confirmed_at = COALESCE(recovery_confirmed_at, CURRENT_TIMESTAMP)
          WHERE id = 1
        `).run(protection.seal(recovered.toString('base64')));
      }
      dataKey = recovered;
      current = 'ready';
    },
    dispose() {
      dataKey?.fill(0);
      dataKey = null;
      disposed = true;
    }
  };
}
