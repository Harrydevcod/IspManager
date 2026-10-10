import type Database from 'better-sqlite3';
import { journalDisk } from './router-log-watch';
import {
  ensureClientUsageCounter, ensureWanUsageCounter, listDisks, usageCounterMark, type RouterTransport
} from './routeros';
import { CLIENT_USAGE_NAME, CLIENT_USAGE_VERSION } from './routeros-client-script';
import { WAN_USAGE_NAME, WAN_USAGE_VERSION } from './routeros-wan-script';

/**
 * A instalação dos contadores no router e onde cada um guarda o estado.
 * O ISPM lembra-se do que instalou (`app_settings`): é isso que diz ao trabalho da contagem
 * em que disco ler, e quando a versão instalada ficou para trás.
 */
export type UsageCounterKind = 'wan' | 'client';

const COUNTERS = {
  wan: { name: WAN_USAGE_NAME, version: WAN_USAGE_VERSION, ensure: ensureWanUsageCounter, setting: 'wanUsageCounter' },
  client: { name: CLIENT_USAGE_NAME, version: CLIENT_USAGE_VERSION, ensure: ensureClientUsageCounter, setting: 'clientUsageCounter' }
} as const;

const readSetting = (db: Database.Database, key: string) =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

/** O disco onde o contador instalado guarda o estado; `null` se guarda no script de dados. */
export function usageCounterDisk(db: Database.Database, kind: UsageCounterKind): string | null {
  return /@(\S+)$/.exec(readSetting(db, COUNTERS[kind].setting) ?? '')?.[1] ?? null;
}

/**
 * O disco do diário do registo, se houver; senão o primeiro disco amovível do router. Um disco
 * por formatar aparece na lista sem sistema de ficheiros (`-`) e não serve.
 */
async function pickDisk(db: Database.Database, transport: RouterTransport): Promise<string | null> {
  const disks = (await listDisks(transport)).filter((disk) => disk.fs && disk.fs !== '-')
    .map((disk) => disk.slot).filter((slot) => /^[\w-]+$/.test(slot));
  const journal = journalDisk(db);
  return journal !== null && disks.includes(journal) ? journal : disks[0] ?? null;
}

/**
 * Instala ou atualiza o contador e corre-o uma vez: é essa corrida que passa o estado do script
 * de dados para o ficheiro. Só depois de tudo correr é que o ISPM assume a instalação nova.
 */
export async function installUsageCounter(db: Database.Database, transport: RouterTransport, kind: UsageCounterKind): Promise<{ disk: string | null }> {
  const counter = COUNTERS[kind];
  const disk = await pickDisk(db, transport);
  await counter.ensure(transport, disk);
  await transport({ method: 'POST', path: '/system/script/run', body: { '.id': counter.name } });
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(counter.setting, usageCounterMark(counter.version, disk));
  return { disk };
}

/**
 * Atualiza um contador que já está no router e ficou numa versão antiga. Devolve se mexeu.
 * `installed` é a prova de que o contador lá está: o ISPM nunca o instala sem ser pedido.
 */
export async function refreshUsageCounter(db: Database.Database, transport: RouterTransport, kind: UsageCounterKind, installed: boolean): Promise<boolean> {
  if (!installed || (readSetting(db, COUNTERS[kind].setting) ?? '').startsWith(COUNTERS[kind].version)) return false;
  await installUsageCounter(db, transport, kind);
  return true;
}

/**
 * O mesmo, para o trabalho da contagem: uma atualização que falha não pára a contagem, mas
 * fica dita no resultado do trabalho (aba dos trabalhos) em vez de se perder.
 */
export async function refreshUsageCounterForJob(
  db: Database.Database, transport: RouterTransport, kind: UsageCounterKind, installed: boolean
): Promise<{ counterUpdated?: true; counterError?: string }> {
  try {
    return await refreshUsageCounter(db, transport, kind, installed) ? { counterUpdated: true } : {};
  } catch (err) {
    return { counterError: err instanceof Error ? err.message : String(err) };
  }
}
