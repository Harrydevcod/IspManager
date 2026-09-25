import type Database from 'better-sqlite3';
import type { Vault } from './vault';

/**
 * Credenciais de infraestrutura, cifradas pelo cofre (ver `vault.ts` e o plano
 * `docs/superpowers/plans/2026-09-24-cofre-de-credenciais.md`).
 *
 * O ISPM precisa destes valores **em claro em tempo de execução** — são senhas
 * que ele tem de apresentar ao router, à UltraMsg e ao telemóvel. Não podem ser
 * hashes. Ficam gravadas como `enc:v2:` com o AAD `app_settings.<chave>`; a
 * chave de dados não viaja com o ficheiro, e noutra máquina só a chave de
 * recuperação a devolve.
 *
 * O que isto **não** protege: código malicioso a correr como este mesmo
 * utilizador. O DPAPI decifra para ele tal como decifra para nós.
 *
 * ## Regras
 *
 * - **Ler** devolve vazio quando a credencial não existe **ou** não se pode
 *   abrir aqui (cofre trancado/ausente, valor legado por migrar). Todos os
 *   consumidores tratam vazio como "não configurado" e não contactam o
 *   transporte — é isso que mantém a D4: com o cofre trancado, as Definições e
 *   o resto da aplicação continuam de pé, só as integrações param.
 * - **Gravar** exige o cofre: nunca cai para texto simples. Vazio apaga, e
 *   apagar não precisa do cofre.
 * - **Nunca** se apaga um valor por não o conseguir abrir (D5). O aviso
 *   `secretsLost` diz o que está indisponível.
 */

const VAULT_PREFIX = 'enc:v2:';

/** Onde o arranque deixa escrito o que não conseguiu abrir. Não é segredo. */
export const SECRETS_LOST_KEY = 'secretsLost';

/**
 * As credenciais portáteis de infraestrutura. A assinatura das sessões saiu
 * daqui para `session-secret.ts`: recria-se num restauro, não se recupera.
 */
export const SECRET_KEYS = ['routerosPassword', 'ultraMsgToken', 'smsCompanionPairingKey'] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

/** Como se chama cada um à frente de quem o vai ter de reintroduzir. */
export const SECRET_LABELS: Record<SecretKey, string> = {
  routerosPassword: 'Senha do router de gestão',
  ultraMsgToken: 'Token UltraMsg',
  smsCompanionPairingKey: 'Pareamento do telemóvel SMS'
};

/** AAD de cada domínio (D2): separa tabelas/colunas, não linhas. */
export function secretContext(key: SecretKey): string {
  return `app_settings.${key}`;
}

export const PPPOE_CONTEXT = 'services.pppoe_password';

export function isVaultCiphertext(value: string): boolean {
  return value.startsWith(VAULT_PREFIX);
}

let vault: Vault | null = null;

/** O arranque instala o cofre aberto; os testes instalam o seu. */
export function setCredentialVault(next: Vault | null): void {
  vault = next;
}

export function getCredentialVault(): Vault | null {
  return vault;
}

/** Há um cofre aberto nesta sessão? Sem ele, nenhuma credencial se grava. */
export function canStoreSecrets(): boolean {
  try {
    const status = vault?.status();
    return status === 'ready' || status === 'recovery_pending';
  } catch {
    return false;
  }
}

/** `null` = há bytes mas não abrem aqui; '' = não há nada. */
function openStored(context: string, stored: string): string | null {
  if (!stored) return '';
  if (!isVaultCiphertext(stored) || !canStoreSecrets()) return null;
  try {
    return vault!.decrypt(context, stored);
  } catch {
    return null;
  }
}

function rawSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

function saveSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function readSecret(db: Database.Database, key: SecretKey): string {
  return openStored(secretContext(key), rawSetting(db, key)) ?? '';
}

export function writeSecret(db: Database.Database, key: SecretKey, value: string): void {
  if (value === '') {
    saveSetting(db, key, '');
    return;
  }
  if (!vault) throw new Error('VAULT_UNAVAILABLE');
  saveSetting(db, key, vault.encrypt(secretContext(key), value));
}

/**
 * Recalcula — a partir do que está gravado — que credenciais não se conseguem
 * abrir aqui, e deixa a lista escrita para as Definições a mostrarem.
 * Recalculado, não acumulado: reescrever a credencial cala o aviso sozinho.
 */
export function refreshSecretsLost(db: Database.Database): string[] {
  const lost = SECRET_KEYS.filter((key) => openStored(secretContext(key), rawSetting(db, key)) === null).map(
    (key) => SECRET_LABELS[key]
  );
  saveSetting(db, SECRETS_LOST_KEY, JSON.stringify(lost));
  return lost;
}

/** O que o arranque não conseguiu abrir, para as Definições avisarem. */
export function readSecretsLost(db: Database.Database): string[] {
  try {
    const parsed = JSON.parse(rawSetting(db, SECRETS_LOST_KEY) || '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
