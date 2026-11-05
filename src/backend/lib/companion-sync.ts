import { getSqliteDatabase } from '../db/database';
import { readSecret } from './secrets';
import { selfHealCompanionAddress, signedFetch } from './sms-outbox';
import { buildCompanionSnapshot, type CompanionSnapshot } from './companion-snapshot';
import { appSupportsSealed, payloadForApp } from './companion-crypto';

/**
 * Sincronização desktop → telemóvel, além dos SMS: o desktop pergunta pelo
 * estado do telemóvel (`GET /status`) e empurra-lhe o resumo do Painel
 * (`POST /dashboard`). Tudo pelo canal assinado do pareamento; a API do
 * desktop continua fechada à rede. Com o telemóvel offline, nada fica em fila:
 * só interessa o resumo mais recente.
 */

export type CompanionDeviceStatus = {
  appVersion: string | null;
  battery: number | null;
  charging: boolean | null;
  signalLevel: number | null;
  simOperators: string[];
  pending: number | null;
  uptimeSec: number | null;
};

export type CompanionSyncDeps = {
  fetchStatus: () => Promise<{ reachable: boolean; status: CompanionDeviceStatus | null }>;
  pushSnapshot: (snapshot: CompanionSnapshot, sealed: boolean) => Promise<boolean>;
  buildSnapshot: () => Promise<CompanionSnapshot>;
  selfHeal: () => Promise<void>;
};

const LAST_SEEN_KEY = 'smsCompanionLastSeen';
const STATUS_KEY = 'smsCompanionDeviceStatus';
/**
 * Once this pairing has seen an app that decrypts, the snapshot always goes
 * sealed: the version in /status is not signed, so a host posing as the phone
 * must not be able to talk the desktop back into plain text. Cleared only by a
 * new pairing or a revoke (routes/sms.ts).
 */
export const SEALED_KEY = 'smsCompanionSealed';
const DEFAULT_SNAPSHOT_MINUTES = 5;

// Estado do processo, não da base: perder isto num reinício só antecipa um push.
let lastPushAt = 0;
let wasOnline = false;

export function resetCompanionSyncForTests() {
  lastPushAt = 0;
  wasOnline = false;
}

function getSetting(key: string): string {
  const row = getSqliteDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || '';
}

function setSetting(key: string, value: string) {
  getSqliteDatabase().prepare(`
    INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, value);
}

export function snapshotIntervalMs(): number {
  const n = Number(getSetting('smsCompanionSnapshotMinutes'));
  return (Number.isFinite(n) && n >= 1 && n <= 60 ? n : DEFAULT_SNAPSHOT_MINUTES) * 60_000;
}

/** Força o próximo tick a enviar já (pareamento novo, por exemplo). */
export function requestCompanionSnapshotPush() {
  lastPushAt = 0;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Lê o JSON do telemóvel sem confiar na forma: campos estranhos viram null. */
export function parseDeviceStatus(json: Record<string, unknown>): CompanionDeviceStatus {
  return {
    appVersion: typeof json.appVersion === 'string' ? json.appVersion.slice(0, 32) : null,
    battery: num(json.battery),
    charging: typeof json.charging === 'boolean' ? json.charging : null,
    signalLevel: num(json.signalLevel),
    simOperators: Array.isArray(json.simOperators) ? json.simOperators.filter((s): s is string => typeof s === 'string').slice(0, 4).map((s) => s.slice(0, 40)) : [],
    pending: num(json.pending),
    uptimeSec: num(json.uptimeSec)
  };
}

async function defaultFetchStatus(): Promise<{ reachable: boolean; status: CompanionDeviceStatus | null }> {
  try {
    const response = await signedFetch('/status', 'GET', undefined, 3500);
    // 401: o telemóvel responde mas não tem este pareamento — não conta como visto.
    if (response.status === 401) return { reachable: false, status: null };
    // App 0.2.0 ainda sem /status (404): está viva, só não diz mais nada.
    if (!response.ok) return { reachable: true, status: null };
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { reachable: true, status: parseDeviceStatus(json) };
  } catch {
    return { reachable: false, status: null };
  }
}

async function defaultPushSnapshot(snapshot: CompanionSnapshot, sealed: boolean): Promise<boolean> {
  const secret = readSecret(getSqliteDatabase(), 'smsCompanionPairingKey');
  if (!secret) return false;
  try {
    const response = await signedFetch('/dashboard', 'POST', payloadForApp(snapshot, sealed, secret), 5000);
    return response.ok;
  } catch {
    return false;
  }
}

const defaultDeps: CompanionSyncDeps = {
  fetchStatus: defaultFetchStatus,
  pushSnapshot: defaultPushSnapshot,
  buildSnapshot: () => buildCompanionSnapshot(),
  selfHeal: selfHealCompanionAddress
};

export type CompanionSyncResult =
  | { skipped: true; reason: string }
  | { online: boolean; pushed: boolean };

/**
 * Um tick (de minuto a minuto): estado do telemóvel e, se for altura, o resumo.
 * Offline → procura o telemóvel na rede logo (o IP pode ter mudado), em vez
 * de esperar que haja SMS na fila.
 */
export async function runCompanionSyncIfDue(now: Date = new Date(), deps: CompanionSyncDeps = defaultDeps): Promise<CompanionSyncResult> {
  if (getSetting('smsCompanionEnabled') !== 'true' || !getSetting('smsCompanionBaseUrl') || !readSecret(getSqliteDatabase(), 'smsCompanionPairingKey')) {
    return { skipped: true, reason: 'telemovel SMS nao pareado' };
  }

  let { reachable, status } = await deps.fetchStatus();
  if (!reachable) {
    await deps.selfHeal();
    ({ reachable, status } = await deps.fetchStatus());
  }
  if (!reachable) {
    wasOnline = false;
    return { online: false, pushed: false };
  }

  setSetting(LAST_SEEN_KEY, now.toISOString());
  if (status) setSetting(STATUS_KEY, JSON.stringify(status));

  // Volta a estar online → envia já, para o Painel não ficar com o resumo velho.
  const due = !wasOnline || now.getTime() - lastPushAt >= snapshotIntervalMs();
  wasOnline = true;
  if (!due) return { online: true, pushed: false };

  if (appSupportsSealed(status?.appVersion)) setSetting(SEALED_KEY, 'true');
  const pushed = await deps.pushSnapshot(await deps.buildSnapshot(), getSetting(SEALED_KEY) === 'true');
  if (pushed) lastPushAt = now.getTime();
  return { online: true, pushed };
}

/** O que o desktop sabe do telemóvel sem lhe perguntar (para o ecrã de Definições). */
export function readCompanionPresence(): { lastSeen: string | null; device: CompanionDeviceStatus | null } {
  const lastSeen = getSetting(LAST_SEEN_KEY) || null;
  const raw = getSetting(STATUS_KEY);
  let device: CompanionDeviceStatus | null = null;
  if (raw) {
    try { device = parseDeviceStatus(JSON.parse(raw) as Record<string, unknown>); } catch { device = null; }
  }
  return { lastSeen, device };
}
