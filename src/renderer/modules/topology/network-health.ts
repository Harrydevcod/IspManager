import { authFetch } from '../../lib/auth';

export type FindingKind = 'antena_em_baixo' | 'ip_duplicado' | 'dhcp_intruso' | 'dhcp_ciclo' | 'pppoe_queda' | 'login_falhado';
export type HealthTone = 'ok' | 'warn' | 'danger';
export type HealthOutage = { id: number; name: string; ipAddress: string; downs: number; downSeconds: number; longestSeconds: number };
export type HealthDown = { kind: 'backbone' | 'assignment'; id: number; name: string; ipAddress: string; since: string };
export type HealthFinding = {
  kind: FindingKind; subject: string; label: string; count: number; firstAt: string; lastAt: string;
  deviceName: string | null; clientName: string | null; vendor: string | null;
};
export type DiaryStatus = 'aberta' | 'resolvida';
export type DiaryEntry = {
  id: number; happenedAt: string; title: string; cause: string; resolution: string; status: DiaryStatus; createdAt: string; updatedAt: string;
};
export type NetworkHealth = {
  hours: number;
  tone: HealthTone;
  probeEnabled: boolean;
  lastProbeAt: string | null;
  lastRouterReadAt: string | null;
  routerJournal: boolean;
  antennas: HealthOutage[];
  clients: HealthOutage[];
  downNow: HealthDown[];
  findings: HealthFinding[];
  diary: DiaryEntry[];
};

export const NETWORK_API = 'http://127.0.0.1:3001/api/network';

export const TONE_LABEL: Record<HealthTone, { label: string; badge: 'success' | 'warn' | 'danger' }> = {
  ok: { label: 'Estável', badge: 'success' },
  warn: { label: 'Atenção', badge: 'warn' },
  danger: { label: 'Crítico', badge: 'danger' }
};

export const KIND_LABEL: Record<FindingKind, string> = {
  ip_duplicado: 'Endereço do router duplicado',
  antena_em_baixo: 'Queda vista pelo router',
  dhcp_intruso: 'DHCP intruso',
  pppoe_queda: 'Queda de PPPoE',
  dhcp_ciclo: 'Ciclo de DHCP',
  login_falhado: 'Login falhado no router'
};

/** A gravidade de um achado: o painel e a aba Incidentes pintam-no pela mesma escala. */
export function findingTone(kind: FindingKind): 'danger' | 'warn' | 'neutral' {
  return kind === 'ip_duplicado' ? 'danger' : kind === 'antena_em_baixo' || kind === 'dhcp_intruso' ? 'warn' : 'neutral';
}

/** A quem o achado diz respeito, do nome mais útil para o menos. */
export function findingWho(finding: HealthFinding): string {
  return finding.deviceName ?? finding.clientName ?? finding.vendor ?? '—';
}

/**
 * Horas que já estão na hora local — as do registo do router (`AAAA-MM-DD hh:mm:ss`) e as do
 * diário (`AAAA-MM-DDThh:mm`). Passá-las pelo formatador das datas da base, que as lê como
 * UTC, desviava-as uma hora. Sem o ano cabe numa coluna estreita: a janela é de dias.
 */
export function formatLocalStamp(value: string, withYear = true): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}/${match[2]}${withYear ? `/${match[1]}` : ''} ${match[4]}:${match[5]}`;
}

export type Situation = { key: string; tone: 'danger' | 'warn' | 'neutral'; title: string; detail: string; count: number | null };

/**
 * O que o painel mostra primeiro: o backbone em baixo agora, depois os achados do router pela
 * gravidade, depois as antenas que a sonda viu cair e o router não (lido tarde ou nunca), e por
 * fim os equipamentos de cliente sem resposta.
 */
export function healthSituations(health: NetworkHealth): Situation[] {
  const seenByRouter = new Set(health.findings.filter((row) => row.kind === 'antena_em_baixo').map((row) => row.subject));
  return [
    ...health.downNow.filter((row) => row.kind === 'backbone').map((row): Situation => ({
      key: `down:${row.id}`, tone: 'danger', title: `${row.name} em baixo`, detail: row.ipAddress, count: null
    })),
    ...health.findings.map((row): Situation => ({
      key: `${row.kind}:${row.subject}`,
      tone: findingTone(row.kind),
      title: row.kind === 'antena_em_baixo' ? `${row.deviceName ?? row.clientName ?? row.subject} caiu` : KIND_LABEL[row.kind],
      detail: row.kind === 'antena_em_baixo'
        ? `${row.subject} · visto pelo router`
        : [row.clientName ?? row.vendor, row.subject, row.label].filter(Boolean).join(' · '),
      count: row.count
    })),
    ...health.antennas.filter((row) => !seenByRouter.has(row.ipAddress)).map((row): Situation => ({
      key: `probe:${row.id}`, tone: 'warn', title: `${row.name} caiu`, detail: `${row.ipAddress} · visto pela sonda`, count: row.downs
    })),
    ...health.downNow.filter((row) => row.kind === 'assignment').map((row): Situation => ({
      key: `client:${row.id}`, tone: 'neutral', title: `${row.name} sem resposta`, detail: `${row.ipAddress} · equipamento de cliente`, count: null
    }))
  ];
}

/**
 * Quedas das antenas na janela. O router vê mais do que a sonda (testa de 30 em 30 segundos e
 * continua com o ISPM fechado), por isso vale, por antena, a contagem maior das duas.
 */
export function antennaDrops(health: NetworkHealth): number {
  const drops = new Map(health.antennas.map((row) => [row.ipAddress, row.downs]));
  for (const row of health.findings) {
    if (row.kind === 'antena_em_baixo' && row.deviceName) drops.set(row.subject, Math.max(drops.get(row.subject) ?? 0, row.count));
  }
  return [...drops.values()].reduce((total, count) => total + count, 0);
}

/** Lê ou escreve na API da rede e devolve o corpo; um erro traz a mensagem do servidor. */
export async function networkRequest<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await authFetch(`${NETWORK_API}${path}`, init && {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(init.body ?? {})
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Não foi possível concluir o pedido.');
  return body;
}
