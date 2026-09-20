import type Database from 'better-sqlite3';

/**
 * Credenciais de infraestrutura seladas na conta do sistema operativo.
 *
 * O ISPM precisa destes valores **em claro em tempo de execução** — são senhas
 * que ele tem de apresentar ao router, à UltraMsg e ao telemóvel. Não podem ser
 * hashes. A pergunta útil não é "como os tornamos irrecuperáveis" mas "quem os
 * consegue recuperar".
 *
 * Cifrar a base com uma chave guardada ao lado dela não responde a nada: quem
 * copia o ficheiro copia a chave. O `safeStorage` do Electron responde — no
 * Windows é o DPAPI, e a chave é da conta do utilizador, não da aplicação. Um
 * `ispm.sqlite` copiado para outra máquina, um backup numa pen ou um disco
 * roubado deixam de dar credencial nenhuma.
 *
 * O que isto **não** protege, e convém dizer: código malicioso a correr como
 * este mesmo utilizador. O DPAPI decifra para ele tal como decifra para nós.
 * Isto eleva a fasquia; não a torna intransponível.
 *
 * ## Compatibilidade
 *
 * Um valor sem o prefixo `enc:v1:` é texto simples — é assim que se lê o que já
 * estava gravado, e é assim que funciona onde não há cifra (os testes correm
 * sem Electron; o Linux pode não ter keyring). Nunca se apaga um segredo por
 * não haver cifra disponível.
 *
 * ## Quando o Electron 46 chegar
 *
 * A API síncrona do `safeStorage` desaparece na 46, substituída por
 * `encryptStringAsync`/`decryptStringAsync` — e o que foi selado com a síncrona
 * abre com a assíncrona. É por isso que nenhum chamador vê o `safeStorage`: no
 * dia da atualização mexe-se neste ficheiro, e os nove sítios que leem segredos
 * ficam onde estão.
 */

const SEALED_PREFIX = 'enc:v1:';

/** Onde o arranque deixa escrito o que não conseguiu abrir. Não é segredo. */
export const SECRETS_LOST_KEY = 'secretsLost';

/**
 * As credenciais de infraestrutura. O PPPoE dos clientes fica de fora de
 * propósito: sela-lo protegia um campo numa base que continua a ter o nome, o
 * NIF e a morada de toda a gente em claro, e num restauro noutra máquina
 * deixava o parque inteiro sem credenciais recuperáveis.
 */
export const SECRET_KEYS = [
  'routerosPassword',
  'ultraMsgToken',
  'smsCompanionPairingKey',
  'auth_secret'
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

/** Como se chama cada um à frente de quem o vai ter de reintroduzir. */
export const SECRET_LABELS: Record<SecretKey, string> = {
  routerosPassword: 'Senha do router de gestão',
  ultraMsgToken: 'Token UltraMsg',
  smsCompanionPairingKey: 'Pareamento do telemóvel SMS',
  auth_secret: 'Chave das sessões (todos terão de entrar outra vez)'
};

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(buffer: Buffer): string;
};

let cachedSafeStorage: SafeStorage | null | undefined;

/**
 * O Electron só existe quando a aplicação corre a sério. Nos testes e em
 * qualquer arranque headless isto devolve `null` e tudo segue em claro.
 */
function safeStorage(): SafeStorage | null {
  if (cachedSafeStorage !== undefined) return cachedSafeStorage;
  cachedSafeStorage = null;
  if (process.versions.electron) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { safeStorage?: SafeStorage };
      if (electron.safeStorage) cachedSafeStorage = electron.safeStorage;
    } catch {
      // Sem Electron ao alcance: segue em claro, como antes.
    }
  }
  return cachedSafeStorage;
}

/**
 * Costura para os testes, que precisam de exercitar os dois caminhos — selado e
 * em claro — sem Electron. `null` força o caminho do texto simples;
 * `undefined` devolve a deteção automática.
 */
export function setSealingBackend(storage: SafeStorage | null | undefined): void {
  cachedSafeStorage = storage;
}

/** Só para os testes, que precisam de forçar os dois caminhos. */
export function resetSealingCache(): void {
  cachedSafeStorage = undefined;
}

export function isSealingAvailable(): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    return storage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/** Sela se puder; devolve o próprio valor quando não há cifra disponível. */
export function sealValue(plain: string): string {
  if (!plain) return '';
  const storage = safeStorage();
  if (!storage || !isSealingAvailable()) return plain;
  try {
    return SEALED_PREFIX + storage.encryptString(plain).toString('base64');
  } catch {
    // Selar é uma melhoria, não uma condição: falhar aqui não pode custar a
    // credencial a quem a acabou de escrever.
    return plain;
  }
}

/**
 * Abre um valor guardado. `null` quer dizer "está selado e não é meu" — que é
 * diferente de "está vazio", e é essa diferença que o arranque usa para avisar
 * depois de um restauro noutra máquina.
 */
export function unsealValue(stored: string): string | null {
  if (!stored) return '';
  if (!isSealed(stored)) return stored;
  const storage = safeStorage();
  if (!storage) return null;
  try {
    return storage.decryptString(Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ na base

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

/**
 * Lê uma credencial já aberta. Vazio quando não existe **ou** quando não é
 * desta máquina — quem lê uma senha para a usar não tem nada a fazer com a
 * diferença, e mandá-la para o router seria pior do que não mandar nada.
 */
export function readSecret(db: Database.Database, key: SecretKey): string {
  return unsealValue(rawSetting(db, key).trim()) ?? '';
}

export function writeSecret(db: Database.Database, key: SecretKey, value: string): void {
  saveSetting(db, key, sealValue(value.trim()));
}

/**
 * Passagem de arranque, a seguir às migrações.
 *
 * Faz duas coisas: sela o que ainda está em claro (é o que migra as instalações
 * existentes, sem migração SQL — ver ADR 0003 e a lição de migrações aplicadas
 * a meio de uma corrida de dev), e deteta o que foi selado por outra conta.
 *
 * O segundo caso só se limpa quando **há** cifra disponível: aí um bloco que
 * não abre é prova de que veio de outra máquina. Sem cifra, um bloco selado é
 * só um bloco que esta máquina não sabe abrir hoje — apagá-lo seria destruir a
 * credencial de quem arrancou a aplicação no sítio errado.
 *
 * Devolve as etiquetas do que se perdeu, e deixa-as gravadas para as Definições
 * as poderem mostrar depois do reinício que o restauro obriga.
 */
export function sealPendingSecrets(db: Database.Database): string[] {
  const available = isSealingAvailable();
  const lost: string[] = [];

  const run = db.transaction(() => {
    for (const key of SECRET_KEYS) {
      const stored = rawSetting(db, key).trim();
      if (!stored) continue;

      if (!isSealed(stored)) {
        if (available) saveSetting(db, key, sealValue(stored));
        continue;
      }

      if (!available) continue;
      if (unsealValue(stored) !== null) continue;

      // Selado, com cifra a funcionar, e mesmo assim não abre: outra conta.
      saveSetting(db, key, '');
      lost.push(SECRET_LABELS[key]);
    }
    saveSetting(db, SECRETS_LOST_KEY, JSON.stringify(lost));
  });
  run();

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

export function clearSecretsLost(db: Database.Database): void {
  saveSetting(db, SECRETS_LOST_KEY, '[]');
}
