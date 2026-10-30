import type {
  AssignmentListQuery,
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneDeviceSummary,
  BackbonePage,
  BackboneListQuery,
  BackboneWriteInput
} from '../../../shared/backbone';
import type { TopologyLinkProperties } from '../../../shared/topology';
import { authFetch } from '../../lib/auth';

const API_BASE = 'http://127.0.0.1:3001';

export type BackboneFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type BackboneCatalogOption = {
  id: number;
  brand: string | null;
  model: string;
  type: string;
  /** Unidades em armazém. Só a lista do stock o traz; o diálogo não precisa. */
  stockTotal?: number;
  /** Unidades instaladas na rede — é o que ordena os "mais usados" da paleta. */
  backboneCount?: number;
};

type StockCatalogWireRow = BackboneCatalogOption & {
  category: 'equipamento' | 'material';
  active: number | boolean;
};

export class BackboneApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'BackboneApiError';
  }
}

function listUrl(path: string, query: BackboneListQuery | AssignmentListQuery): string {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize)
  });
  if ('status' in query && query.status) params.set('status', query.status);
  if ('upstreamDeviceId' in query && query.upstreamDeviceId) {
    params.set('upstreamDeviceId', String(query.upstreamDeviceId));
  }
  if ('mapping' in query) params.set('mapping', query.mapping);
  if (query.query?.trim()) params.set('query', query.query.trim());
  if ('backboneDeviceId' in query && query.backboneDeviceId) {
    params.set('backboneDeviceId', String(query.backboneDeviceId));
  }
  return `${API_BASE}${path}?${params.toString()}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const parsed = await response.json().then(
    (value) => ({ value, valid: true }),
    () => ({ value: null, valid: false })
  );
  const payload = parsed.value as { error?: unknown } | null;
  if (response.ok) {
    if (!parsed.valid) throw new BackboneApiError('Backbone response contained invalid JSON', response.status);
    return payload as T;
  }
  const message = typeof payload?.error === 'string'
    ? payload.error
    : `Backbone request failed (${response.status})`;
  throw new BackboneApiError(message, response.status);
}

function jsonMutation<T>(
  fetcher: BackboneFetcher,
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown
): Promise<T> {
  return fetcher(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(readJson<T>);
}

export function createBackboneApi(fetcher: BackboneFetcher = authFetch) {
  return {
    listCatalogs: (): Promise<BackboneCatalogOption[]> => fetcher(`${API_BASE}/api/stock/summary`)
      .then(readJson<{ rows: StockCatalogWireRow[] }>)
      .then(({ rows }) => rows
        .filter((row) => row.category === 'equipamento' && (row.active === true || row.active === 1))
        .map(({ id, brand, model, type, stockTotal, backboneCount }) => ({
          id, brand, model, type, stockTotal: stockTotal ?? 0, backboneCount: backboneCount ?? 0
        }))),
    /** Cria só a linha do catálogo: sem stock nem custo, que se lançam no Stock. */
    createCatalog: (input: { brand: string; model: string; type: string }) => jsonMutation<{ id: number }>(
      fetcher, `${API_BASE}/api/equipment-catalog`, 'POST', { category: 'equipamento', ...input }
    ),
    listBackbones: (query: BackboneListQuery) => fetcher(
      listUrl('/api/topology/backbones', query)
    ).then(readJson<BackbonePage<BackboneDeviceSummary>>),
    listAssignments: (query: AssignmentListQuery) => fetcher(
      listUrl('/api/topology/assignments', query)
    ).then(readJson<BackbonePage<BackboneAssignmentSummary>>),
    getBackbone: (id: number) => fetcher(
      `${API_BASE}/api/topology/backbones/${id}`
    ).then(readJson<BackboneDeviceDetail>),
    createBackbone: (input: BackboneWriteInput) => jsonMutation<BackboneDeviceDetail>(
      fetcher, `${API_BASE}/api/topology/backbones`, 'POST', input
    ),
    updateBackbone: (id: number, input: BackboneWriteInput) => jsonMutation<BackboneDeviceDetail>(
      fetcher, `${API_BASE}/api/topology/backbones/${id}`, 'PUT', input
    ),
    /** Descreve uma ligação que já existe (0091): meio, portas, frequência, capacidade. */
    updateLink: (deviceId: number, upstreamDeviceId: number, link: TopologyLinkProperties) => jsonMutation<TopologyLinkProperties>(
      fetcher, `${API_BASE}/api/topology/links/${deviceId}/${upstreamDeviceId}`, 'PUT', link
    ),
    linkAssignment: (assignmentId: number, backboneDeviceId: number, reason: string | null) => jsonMutation<BackboneAssignmentSummary>(
      fetcher, `${API_BASE}/api/topology/assignments/${assignmentId}/backbone`, 'PUT', { backboneDeviceId, reason }
    ),
    unlinkAssignment: (assignmentId: number, reason: string | null) => jsonMutation<{ assignmentId: number; backboneDeviceId: null }>(
      fetcher, `${API_BASE}/api/topology/assignments/${assignmentId}/backbone`, 'DELETE', { reason }
    )
  };
}

export type BackboneApi = ReturnType<typeof createBackboneApi>;
