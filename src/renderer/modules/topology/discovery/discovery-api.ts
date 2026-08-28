import { authFetch } from '../../../lib/auth';

const API_BASE = 'http://127.0.0.1:3001';

export type DiscoveryFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type DiscoveryCategory = 'desconhecido' | 'registado' | 'ausente' | 'reservado' | 'duplicado';

/** `active: false` — ocupa o endereço mas não se espera que responda. */
export type RegisteredRef = {
  kind: 'backbone' | 'assignment';
  id: number;
  name: string;
  active: boolean;
  model: string | null;
};

/** `registo` = o que o ISPM já sabia; os outros vieram de perguntar à rede. */
export type RowModelSource = 'registo' | 'snmp' | 'router' | 'http';

export type DiscoveryRow = {
  ip: string;
  mac: string | null;
  hostname: string | null;
  vendor: string | null;
  category: DiscoveryCategory;
  alive: boolean;
  rttMs: number | null;
  source: string | null;
  registeredAs: RegisteredRef[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  model: string | null;
  modelSource: RowModelSource | null;
  /** Registo e aparelho discordam — quase sempre equipamento trocado no terreno. */
  modelMismatch: boolean;
  /** O que a rede respondeu, mesmo quando é o modelo do registo que se mostra. */
  probedModel: string | null;
};

export type DiscoveryReport = {
  rows: DiscoveryRow[];
  counts: Record<DiscoveryCategory | 'livre', number>;
  freeIps: string[];
  nextFreeIp: string | null;
  registeredIps: string[];
  /** Zero = ainda não se varreu nada; ver a nota no relatório do backend. */
  rangeSize: number;
  routerEnriched: boolean;
  routerConfigured: boolean;
};

export type SweepRow = { ip: string; ok: boolean; rttMs: number | null; hostname: string | null };

/**
 * O que sobrevive de um varrimento para o cruzamento que vem a seguir.
 *
 * Tem nome porque aparece em quatro sítios — o hook, o que ele guarda para o
 * `refresh`, e a chamada — e alargá-lo em quatro sítios de cada vez que a
 * varredura aprende mais uma coisa é como o `hostname` se perdeu da primeira vez.
 */
export type AliveHost = { ip: string; rttMs: number | null; hostname: string | null };

export type IdentifyRow = { ip: string; model: string | null; modelSource: RowModelSource | null };

export type ProposalKind = 'mac_em_falta' | 'ip_em_falta' | 'ip_mudou' | 'modelo_diferente' | 'backbone_ausente';

/** Uma diferença entre o registo e a rede, com os dois lados à vista. */
export type Proposal = {
  kind: ProposalKind;
  targetKind: 'backbone' | 'assignment';
  targetId: number;
  name: string;
  current: string | null;
  proposed: string;
  ip: string;
  /** Para onde vai quem carrega numa proposta que não se aplica aqui. `null` no backbone. */
  serviceId: number | null;
  clientId: number | null;
};

/** Equipamento registado que a rede não consegue reconhecer, e quem pode ser. */
export type Orphan = {
  targetKind: 'backbone' | 'assignment';
  targetId: number;
  name: string;
  model: string | null;
  candidates: Array<{ ip: string; mac: string | null; vendor: string | null; model: string | null }>;
};

export type Reconciliation = { proposals: Proposal[]; orphans: Orphan[] };

async function readJson<T>(response: Response): Promise<T> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new Error('Resposta ilegível do servidor');
  }
  if (response.ok) return payload as T;
  const message = payload && typeof payload === 'object' && 'error' in payload
    ? String((payload as { error: unknown }).error)
    : `Pedido falhou (${response.status})`;
  throw new Error(message);
}

export function createDiscoveryApi(fetcher: DiscoveryFetcher = authFetch) {
  return {
    /** Um lote de endereços. Só ICMP — ver a rota para o porquê da separação. */
    sweepBatch: (ips: string[], range: string, batchIndex: number, signal?: AbortSignal) =>
      fetcher(`${API_BASE}/api/network/discovery/sweep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ips, range, batchIndex }),
        signal
      }).then(readJson<{ results: SweepRow[] }>),

    /**
     * Pergunta a cada equipamento que aparelho é. Lento e opcional: só corre
     * com o interruptor ligado, e é o único caminho da aba que sai do ICMP.
     */
    identifyBatch: (ips: string[], batchIndex: number, signal?: AbortSignal) =>
      fetcher(`${API_BASE}/api/network/discovery/identify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ips, batchIndex }),
        signal
      }).then(readJson<{ results: IdentifyRow[] }>),

    /** O retrato completo: ARP local + router + histórico + cruzamento. */
    fetchContext: (
      input: { rangeIps: string[]; alive: AliveHost[]; includeRouter: boolean },
      signal?: AbortSignal
    ) =>
      fetcher(`${API_BASE}/api/network/discovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal
      }).then(readJson<DiscoveryReport>),

    /** O que a rede sabe e o registo ainda não. Só lê. */
    fetchProposals: (signal?: AbortSignal) =>
      fetcher(`${API_BASE}/api/network/discovery/proposals`, { signal }).then(readJson<Reconciliation>),

    /** Dispensar escreve sobre a proposta, nunca sobre o equipamento. */
    dismissProposal: (kind: ProposalKind, targetKind: string, targetId: number) =>
      fetcher(`${API_BASE}/api/network/discovery/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, targetKind, targetId })
      }).then(readJson<{ ok: true }>),

    /**
     * Escreve na atribuição de equipamento ativa — a rota do registo, com as
     * validações dela. Só vão os campos que mudam: mandar um IP igual ao que já
     * lá está enche a auditoria de trocas que não aconteceram.
     */
    patchAssignment: (assignmentId: number, patch: { ipAddress?: string; macAddress?: string }) =>
      fetcher(`${API_BASE}/api/service-device-assignments/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      }).then(readJson<unknown>),

    assignIp: (assignmentId: number, ipAddress: string, macAddress: string | null) =>
      fetcher(`${API_BASE}/api/service-device-assignments/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ipAddress, ...(macAddress ? { macAddress } : {}) })
      }).then(readJson<unknown>)
  };
}

export type DiscoveryApi = ReturnType<typeof createDiscoveryApi>;
