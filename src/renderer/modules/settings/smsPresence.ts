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
  // Desligada, o "visto" parou por escolha: nada de offline nem avisos.
  if (status.enabled === false) {
    const last = Number.isFinite(seenAt) ? ` · última resposta ${timeFormat.format(new Date(seenAt))}` : '';
    return { tone: 'muted', line: `Ligação desligada — o pareamento está guardado${last}`, warnings: [] };
  }
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

  // O envio do resumo falha calado do lado do telemóvel; aqui nunca.
  const push = status.lastPush;
  const pushAt = push ? Date.parse(push.at) : NaN;
  if (push && Number.isFinite(pushAt)) {
    if (push.ok) parts.push(`resumo entregue ${ago(now - pushAt)}`);
    else warnings.push(`O resumo não chegou ao telemóvel às ${timeFormat.format(new Date(pushAt))}: ${push.reason ?? 'motivo desconhecido'}.`);
  }

  // Ritmo dos SIMs: quanto falta para o teto e qual a operadora pôs a descansar.
  const budgets = d?.simBudgets ?? [];
  budgets.forEach((b, i) => {
    const label = budgets.length > 1 ? `SIM ${i + 1}` : 'SIM';
    parts.push(`${label} ${b.usedHour}/${b.perHour} nesta hora`);
    const paused = b.pausedUntil ? Date.parse(b.pausedUntil) : NaN;
    if (Number.isFinite(paused) && paused > now) {
      warnings.push(`${label} em pausa até ${timeFormat.format(new Date(paused))}: a operadora recusou por excesso de envios.`);
    } else if (b.usedDay >= b.perDay) {
      warnings.push(`${label} chegou ao teto de ${b.perDay} SMS hoje: os restantes saem amanhã.`);
    }
  });
    if (d?.battery != null && d.battery < 20 && !d.charging) warnings.push('Bateria fraca e sem carregar: ligue o telemóvel à corrente.');
  if (!d?.appVersion || olderVersion(d.appVersion, EXPECTED_SMS_APP_VERSION)) {
    warnings.push(`A app do telemóvel está desatualizada (precisa da ${EXPECTED_SMS_APP_VERSION} para o Painel).`);
  }
  return { tone: warnings.length ? 'warn' : 'success', line: parts.join(' · '), warnings };
}

export type SmsPairingState = 'unpaired' | 'waiting' | 'found' | 'expired' | 'active' | 'mismatch' | 'unreachable' | 'off';

/** A sessão de pareamento v2 aberta neste ecrã (QR à vista ou código por confirmar). */
export type SmsPairingSession = { state: 'waiting' | 'found' | 'expired'; model?: string };

export type SmsPairingView = {
  state: SmsPairingState;
  tone: 'success' | 'warn' | 'danger' | 'muted';
  line: string;
  /** A ação que resolve este estado; 'none' quando nada está por resolver. */
  primary: 'pair' | 'detect' | 'none';
  pairLabel: string;
};

/**
 * Um único estado do pareamento, visto do desktop. Pura: o SmsTab só a desenha.
 * Nunca diz "pareado" sem o telemóvel o ter confirmado com a assinatura.
 */
export function describeSmsPairing(status: SmsStatus | null, session: SmsPairingSession | null): SmsPairingView {
  const name = status?.deviceName || 'Telemóvel';
  const url = status?.baseUrl || 'endereço guardado';
  const view = (state: SmsPairingState, tone: SmsPairingView['tone'], line: string, primary: SmsPairingView['primary'] = 'pair', pairLabel = 'Parear outro telemóvel'): SmsPairingView =>
    ({ state, tone, line, primary, pairLabel });

  if (session?.state === 'found') return view('found', 'success', `Encontrado: ${session.model || 'Telemóvel'}`, 'none');
  if (session?.state === 'waiting') return view('waiting', 'muted', 'À espera de que o telemóvel leia o QR…', 'none');
  if (session?.state === 'expired') return view('expired', 'warn', 'O QR expirou sem ser lido.', 'none');
  if (!status?.configured) return view('unpaired', 'muted', 'Nenhum telemóvel pareado', 'pair', 'Parear telemóvel');
  // Nada a resolver: parear de novo fica disponível, mas não chama a atenção.
  if (status.enabled === false) return view('off', 'muted', `${name} · ligação desligada`, 'none');
  if (status.active) return view('active', 'success', `Ativo: ${name} (${status.baseUrl})`, 'none');
  if (status.reachable) {
    return view('mismatch', 'danger', `${name} responde em ${url}, mas tem outro pareamento. Pareie de novo e, no telemóvel, use "Esquecer e parear de novo".`, 'pair', 'Parear de novo');
  }
  return view('unreachable', 'warn', `${name} não responde em ${url}. Se o IP mudou, "Procurar telemóvel" encontra-o sem novo pareamento.`, 'detect');
}
