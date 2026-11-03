import type { SmsStatus } from '../../types';

/** Versão da app Android que este desktop espera; abaixo disto, o painel não chega. */
export const EXPECTED_SMS_APP_VERSION = '0.3.0';

// O desktop pergunta de minuto a minuto: 3 min sem resposta já é "offline".
const ONLINE_WINDOW_MS = 3 * 60_000;

export type SmsPresence = {
  tone: 'success' | 'warn' | 'muted';
  line: string;
  warnings: string[];
};

function olderVersion(version: string, expected: string): boolean {
  const a = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = expected.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `há ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

const timeFormat = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Uma linha de estado do telemóvel pareado + avisos. Pura; `now` injetável para testes. */
export function describeSmsPresence(status: SmsStatus | null, now = Date.now()): SmsPresence | null {
  if (!status?.configured) return null;
  const seenAt = status.lastSeen ? Date.parse(status.lastSeen) : NaN;
  if (!Number.isFinite(seenAt)) {
    return { tone: 'muted', line: 'Ainda sem notícias do telemóvel', warnings: [] };
  }
  const online = now - seenAt <= ONLINE_WINDOW_MS;
  if (!online) {
    return { tone: 'warn', line: `Offline desde ${timeFormat.format(new Date(seenAt))}`, warnings: [] };
  }

  const d = status.device;
  const parts = ['Online'];
  const warnings: string[] = [];
  if (d?.battery != null) parts.push(`bateria ${Math.round(d.battery)} %${d.charging ? ' a carregar' : ''}`);
  if (d?.signalLevel != null) parts.push(`sinal ${d.signalLevel}/4`);
  if (d?.appVersion) parts.push(`v${d.appVersion}`);
  parts.push(`visto ${ago(now - seenAt)}`);

  if (d?.battery != null && d.battery < 20 && !d.charging) warnings.push('Bateria fraca e sem carregar: ligue o telemóvel à corrente.');
  if (!d?.appVersion || olderVersion(d.appVersion, EXPECTED_SMS_APP_VERSION)) {
    warnings.push(`A app do telemóvel está desatualizada (precisa da ${EXPECTED_SMS_APP_VERSION} para o Painel).`);
  }
  return { tone: warnings.length ? 'warn' : 'success', line: parts.join(' · '), warnings };
}
