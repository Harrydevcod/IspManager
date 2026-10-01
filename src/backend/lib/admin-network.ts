import type Database from 'better-sqlite3';
import { describeRouterFailure, fetchRouterCertificate, fingerprintOf, isRouterConfigured, readRouterConfig } from './routeros';

export type AdminNetworkPresence = {
  state: 'onsite' | 'offsite' | 'foreign' | 'unknown';
  checkedAt: string;
  detail: string;
};

const CACHE_MS = 60_000;
let cached: { key: string; expiresAt: number; value: Promise<AdminNetworkPresence> } | null = null;

export function resetAdminNetworkCacheForTests(): void {
  cached = null;
}

export function offNetworkReason(presence: AdminNetworkPresence): string {
  return `Fora da rede de gestão: ${presence.detail}`;
}

export function isOffNetwork(presence: AdminNetworkPresence): boolean {
  return presence.state === 'offsite' || presence.state === 'foreign';
}

export function detectAdminNetwork(db: Database.Database): Promise<AdminNetworkPresence> {
  const config = readRouterConfig(db);
  const key = `${config.enabled}|${config.host}|${config.port}|${config.user}|${Boolean(config.password)}|${config.tlsCert}`;
  const now = Date.now();
  if (cached?.key === key && cached.expiresAt > now) return cached.value;

  const value = (async (): Promise<AdminNetworkPresence> => {
    const checkedAt = new Date().toISOString();
    if (!config.enabled || !isRouterConfigured(config)) {
      return { state: 'unknown', checkedAt, detail: 'Router de gestão do ISP desligado ou por configurar.' };
    }
    try {
      const presented = await fetchRouterCertificate(config);
      // ponytail: sem certificado fixado só provamos que há um servidor TLS no endereço configurado.
      if (!config.tlsCert || presented.fingerprint === fingerprintOf(config.tlsCert)) {
        return { state: 'onsite', checkedAt, detail: 'Router de gestão do ISP confirmado.' };
      }
      return { state: 'foreign', checkedAt, detail: `Outro aparelho responde em ${config.host} — não é o router de gestão do ISP.` };
    } catch (error) {
      const failure = describeRouterFailure(error);
      const foreign = /CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(failure.code);
      return {
        state: foreign ? 'foreign' : 'offsite',
        checkedAt,
        detail: foreign
          ? `Outro aparelho responde em ${config.host} — não é o router de gestão do ISP. ${failure.title}.`
          : `${failure.title}. ${failure.detail}`
      };
    }
  })();
  cached = { key, expiresAt: now + CACHE_MS, value };
  return value;
}
