import { authFetch } from '../../lib/auth';

export type FindingKind = 'antena_em_baixo' | 'ip_duplicado' | 'laco_rede' | 'dhcp_intruso' | 'dhcp_ciclo' | 'pppoe_queda' | 'login_falhado'
  | 'config_externa' | 'porta_oscila' | 'router_reiniciou';
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
  /** Porque é que a última leitura do registo do router falhou; `null` se correu bem. */
  routerReadError?: string | null;
  antennas: HealthOutage[];
  clients: HealthOutage[];
  downNow: HealthDown[];
  findings: HealthFinding[];
  dropPattern: { periodMinutes: number; lastAt: string; nextAt: string } | null;
  /** O retrato que o router tirou no início da última queda em bloco (script `ispm-queda`). */
  dropCapture?: DropCapture | null;
  diary: DiaryEntry[];
};
export type DropCapture = { at: string; hosts: Array<{ host: string; deviceName: string | null; mac: string; arp: string; port: string }> };

// Os estados do ARP do RouterOS 7 que querem dizer que a antena deixou de responder.
const ARP_LOST = new Set(['failed', 'incomplete']);

/** "CPE710 Espia LAN1 · TL-S5 Cruz sem ARP": onde o router via cada antena quando ela caiu. */
export function captureDetail(capture: DropCapture): string {
  return capture.hosts.map((row) => {
    const name = row.deviceName ?? row.host;
    if (row.mac === '-' || row.mac === '') return `${name} sem ARP`;
    const where = row.port === '-' ? 'fora da bridge' : row.port;
    return `${name} ${where}${ARP_LOST.has(row.arp) ? ' (ARP falhou)' : ''} ${row.mac}`;
  }).join(' · ');
}

export const NETWORK_API = 'http://127.0.0.1:3001/api/network';

export const TONE_LABEL: Record<HealthTone, { label: string; badge: 'success' | 'warn' | 'danger' }> = {
  ok: { label: 'Estável', badge: 'success' },
  warn: { label: 'Atenção', badge: 'warn' },
  danger: { label: 'Crítico', badge: 'danger' }
};

export const KIND_LABEL: Record<FindingKind, string> = {
  laco_rede: 'Laço na rede',
  ip_duplicado: 'Endereço do router duplicado',
  antena_em_baixo: 'Queda vista pelo router',
  dhcp_intruso: 'DHCP intruso',
  pppoe_queda: 'Queda de PPPoE',
  dhcp_ciclo: 'Ciclo de DHCP',
  login_falhado: 'Login falhado no router',
  config_externa: 'Alteração feita fora do ISPM',
  porta_oscila: 'Porta a cair e a voltar',
  router_reiniciou: 'Router reiniciou'
};

const WARN_KINDS: FindingKind[] = ['antena_em_baixo', 'dhcp_intruso', 'config_externa', 'porta_oscila', 'router_reiniciou'];

/** A gravidade de um achado: o painel e a aba Incidentes pintam-no pela mesma escala. */
export function findingTone(kind: FindingKind): 'danger' | 'warn' | 'neutral' {
  return kind === 'ip_duplicado' || kind === 'laco_rede' ? 'danger' : WARN_KINDS.includes(kind) ? 'warn' : 'neutral';
}

/** A quem o achado diz respeito, do nome mais útil para o menos. */
export function findingWho(finding: HealthFinding): string {
  if (finding.kind === 'laco_rede') return 'O próprio router';
  if (finding.kind === 'config_externa') {
    const change = parseConfigChange(finding);
    if (change?.user) return `${change.user}${change.channel ? ` (${change.channel})` : ''}`;
  }
  if (finding.kind === 'router_reiniciou') return 'O próprio router';
  return finding.deviceName ?? finding.clientName ?? finding.vendor ?? '—';
}

/** A coluna "Endereço" da tabela: o que o router escreveu, ou o que foi mexido, já em português. */
export function findingSubject(finding: HealthFinding): string {
  if (finding.kind === 'config_externa') return parseConfigChange(finding)?.object ?? finding.subject;
  if (finding.kind === 'router_reiniciou') return finding.subject === 'relogio' ? 'Relógio' : 'Arranque';
  return finding.subject;
}

/** A coluna "Detalhe" da tabela. */
export function findingLabel(finding: HealthFinding): string {
  if (finding.kind === 'config_externa') return parseConfigChange(finding)?.verb ?? finding.label;
  if (finding.kind === 'porta_oscila') return 'Cabo, ficha ou aparelho a reiniciar';
  return finding.label || '—';
}

/**
 * O que um achado quer dizer em uma linha. No laço, o MAC é o do router e não ajuda ninguém:
 * o que serve é a porta por onde a resposta DHCP dele lhe voltou (o início do `label`).
 */
function findingDetail(finding: HealthFinding): string {
  if (finding.kind === 'antena_em_baixo') return `${finding.subject} · visto pelo router`;
  if (finding.kind === 'laco_rede') {
    const port = finding.label.split(' · ')[0];
    return `O router ouviu a própria resposta DHCP${port ? ` em ${port}` : ''} · procure um cabo em anel`;
  }
  if (finding.kind === 'config_externa') return configChange(finding);
  if (finding.kind === 'porta_oscila') return `${finding.subject} perdeu a ligação · cabo, ficha ou aparelho a reiniciar`;
  if (finding.kind === 'router_reiniciou') return finding.label;
  return [finding.clientName ?? finding.vendor, finding.subject, finding.label].filter(Boolean).join(' · ');
}

const CONFIG_VERBS: Record<string, string> = { added: 'Criou', changed: 'Alterou', removed: 'Removeu' };
const CONFIG_CHANNELS: Record<string, string> = { winbox: 'WinBox', ssh: 'SSH', telnet: 'Telnet', webfig: 'WebFig', terminal: 'terminal' };

/** `ppp secret <admin> added` + `harrytec · winbox` → { verb: 'Criou', object: 'Acesso PPPoE admin', user, channel: 'WinBox' }. */
function parseConfigChange(finding: Pick<HealthFinding, 'subject' | 'label'>) {
  const match = /^(.+?) (added|changed|removed)$/.exec(finding.subject);
  if (!match) return null;
  const object = match[1]
    .replace(/^ppp secret <(.+)>$/, 'Acesso PPPoE $1')
    .replace(/^ppp profile <(.+)>$/, 'Perfil PPP $1')
    .replace(/^user (\S+)$/, 'Utilizador $1')
    // Objetos sem nome no registo do RouterOS (medido a 21/10: "filter rule added").
    .replace(/^filter rule$/, 'Regra de firewall')
    .replace(/^nat rule$/, 'Regra de NAT')
    .replace(/^mangle rule$/, 'Regra de mangle')
    .replace(/^address list entry$/, 'Entrada de lista de endereços')
    .replace(/^pool <(.+)>$/, 'Pool $1');
  const [user = '', channel = ''] = finding.label.split(' · ');
  return { verb: CONFIG_VERBS[match[2]], object, user, channel: CONFIG_CHANNELS[channel] ?? channel };
}

/** "Criou o acesso PPPoE admin · harrytec por WinBox". */
export function configChange(finding: Pick<HealthFinding, 'subject' | 'label'>): string {
  const change = parseConfigChange(finding);
  if (!change) return [finding.subject, finding.label].filter(Boolean).join(' · ');
  const object = change.object.charAt(0).toLowerCase() + change.object.slice(1);
  return `${change.verb} o ${object}${change.user ? ` · ${change.user}${change.channel ? ` por ${change.channel}` : ''}` : ''}`;
}

/** 120 → "2 h"; 90 → "1 h 30". */
export function formatPeriod(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`;
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
    // O ritmo vem antes das quedas soltas: diz a que horas estar junto das antenas.
    ...(health.dropPattern ? [{
      key: 'pattern', tone: 'warn' as const,
      title: `Quedas em bloco a cada ${formatPeriod(health.dropPattern.periodMinutes)}`,
      detail: `Próxima por volta das ${health.dropPattern.nextAt.slice(11, 16)} · última às ${health.dropPattern.lastAt.slice(11, 16)}`,
      count: null
    }] : []),
    ...(health.dropCapture ? [{
      key: 'capture', tone: 'neutral' as const,
      title: `Retrato da queda das ${health.dropCapture.at.slice(11, 16)}`,
      detail: captureDetail(health.dropCapture),
      count: null
    }] : []),
    ...health.findings.map((row): Situation => ({
      key: `${row.kind}:${row.subject}`,
      tone: findingTone(row.kind),
      title: row.kind === 'antena_em_baixo' ? `${row.deviceName ?? row.clientName ?? row.subject} caiu` : KIND_LABEL[row.kind],
      detail: findingDetail(row),
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
