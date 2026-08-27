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

export type IdentifyRow = { ip: string; model: string | null; modelSource: RowModelSource | null };

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
      input: { rangeIps: string[]; alive: Array<{ ip: string; rttMs: number | null }>; includeRouter: boolean },
      signal?: AbortSignal
    ) =>
      fetcher(`${API_BASE}/api/network/discovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal
      }).then(readJson<DiscoveryReport>),

    /** Escreve o IP na atribuição de equipamento ativa — rota que já existia. */
    assignIp: (assignmentId: number, ipAddress: string, macAddress: string | null) =>
      fetcher(`${API_BASE}/api/service-device-assignments/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ipAddress, ...(macAddress ? { macAddress } : {}) })
      }).then(readJson<unknown>)
  };
}

export type DiscoveryApi = ReturnType<typeof createDiscoveryApi>;
