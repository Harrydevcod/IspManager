import type {
  TopologyBackboneBranch,
  TopologySearchFilters,
  TopologySearchResponse,
  TopologySnapshot
} from '../../../shared/topology';
import { authFetch } from '../../lib/auth';

const API_BASE = 'http://127.0.0.1:3001';

export type TopologyFetcher = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

type ErrorPayload = {
  error?: unknown;
};

function errorMessage(payload: unknown, status: number): string {
  if (
    payload
    && typeof payload === 'object'
    && 'error' in payload
    && typeof (payload as ErrorPayload).error === 'string'
  ) return (payload as ErrorPayload).error as string;
  return `Topology request failed (${status})`;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.ok) throw new Error('Topology response contained invalid JSON');
    return null;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await parseJson(response);
  if (response.ok) return payload as T;
  throw new Error(errorMessage(payload, response.status));
}

function appendFilters(
  params: URLSearchParams,
  filters: TopologySearchFilters
): void {
  if (filters.administrativeState) {
    params.set('administrativeState', filters.administrativeState);
  }
  if (filters.attention !== undefined) {
    params.set('attention', String(filters.attention));
  }
  if (filters.island) params.set('island', filters.island);
  if (filters.zone) params.set('zone', filters.zone);
}

function buildSearchUrl(
  query: string,
  filters: TopologySearchFilters,
  limit: number
): string {
  const params = new URLSearchParams({ q: query.trim(), limit: String(limit) });
  appendFilters(params, filters);
  return `${API_BASE}/api/topology/search?${params.toString()}`;
}

export function createTopologyApi(fetcher: TopologyFetcher = authFetch) {
  return {
    fetchSnapshot: () => (
      fetcher(`${API_BASE}/api/topology`).then(readJson<TopologySnapshot>)
    ),
    fetchBranch: (catalogId: number) => (
      fetcher(`${API_BASE}/api/topology/backbones/${catalogId}/clients`)
        .then(readJson<TopologyBackboneBranch>)
    ),
    search: (
      query: string,
      filters: TopologySearchFilters = {},
      limit = 50
    ) => fetcher(buildSearchUrl(query, filters, limit))
      .then(readJson<TopologySearchResponse>)
  };
}

export type TopologyApi = ReturnType<typeof createTopologyApi>;
