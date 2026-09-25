import type Database from 'better-sqlite3';
import type { LocalProtection } from './local-protection';
import { isVaultCiphertext, PPPOE_CONTEXT, SECRET_KEYS, secretContext } from './secrets';
import type { Vault } from './vault';

export type CredentialMigrationResult =
  | { ok: true; converted: number }
  | { ok: false; field: string; reason: string };

interface Item {
  field: string;
  context: string;
  value: string;
  write(sealed: string): void;
}

const KNOWN_ERRORS = new Set([
  'UNKNOWN_ENVELOPE',
  'ROUNDTRIP_MISMATCH',
  'DECRYPT_FAILED',
  'INVALID_CIPHERTEXT',
  'INVALID_SECRET',
  'LOCAL_PROTECTION_FAILED',
  'LOCAL_PROTECTION_UNAVAILABLE',
  'INVALID_LOCAL_ENVELOPE'
]);

/** Texto simples ou `enc:v1:` (DPAPI). Outro `enc:` é desconhecido e aborta. */
function openLegacy(value: string, protection: LocalProtection): string {
  if (value.startsWith('enc:v1:')) return protection.open(value);
  if (value.startsWith('enc:')) throw new Error('UNKNOWN_ENVELOPE');
  return value;
}

/**
 * Converte as credenciais legadas para o cofre, **numa transação síncrona**:
 * uma linha que não se consiga converter aborta tudo e preserva todas as
 * outras. Cada valor é cifrado, decifrado e comparado antes de gravar.
 * Idempotente: o que já é `enc:v2:` só se verifica.
 *
 * Não toca em `pppoe_password_sync_pending`, estados de serviço nem jobs. O
 * resultado identifica o campo (e o id do serviço), nunca o conteúdo.
 */
export function migrateCredentials(
  db: Database.Database,
  vault: Vault,
  protection: LocalProtection
): CredentialMigrationResult {
  const status = vault.status();
  if (status !== 'ready' && status !== 'recovery_pending') return { ok: false, field: 'vault', reason: status };

  const updateSetting = db.prepare('UPDATE app_settings SET value = ? WHERE key = ?');
  const updateService = db.prepare('UPDATE services SET pppoe_password = ? WHERE id = ?');

  const items: Item[] = [];
  for (const key of SECRET_KEYS) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (row?.value) {
      items.push({ field: `app_settings.${key}`, context: secretContext(key), value: row.value, write: (v) => updateSetting.run(v, key) });
    }
  }
  const services = db
    .prepare("SELECT id, pppoe_password AS value FROM services WHERE pppoe_password IS NOT NULL AND pppoe_password <> '' ORDER BY id")
    .all() as Array<{ id: number; value: string }>;
  for (const svc of services) {
    items.push({ field: `services.pppoe_password#${svc.id}`, context: PPPOE_CONTEXT, value: svc.value, write: (v) => updateService.run(v, svc.id) });
  }

  let current = '';
  try {
    const converted = db.transaction(() => {
      let count = 0;
      for (const item of items) {
        current = item.field;
        if (isVaultCiphertext(item.value)) {
          vault.decrypt(item.context, item.value); // só verifica; lança se não for deste cofre
          continue;
        }
        const plain = openLegacy(item.value, protection);
        const sealed = vault.encrypt(item.context, plain);
        if (vault.decrypt(item.context, sealed) !== plain) throw new Error('ROUNDTRIP_MISMATCH');
        item.write(sealed);
        count += 1;
      }
      return count;
    })();
    return { ok: true, converted };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return { ok: false, field: current, reason: KNOWN_ERRORS.has(message) ? message : 'MIGRATION_FAILED' };
  }
}
