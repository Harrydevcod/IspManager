import type {
  AssignmentListQuery,
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneDeviceSummary,
  BackbonePage,
  BackboneListQuery,
  BackboneWriteInput
} from '../../../shared/backbone';
import { authFetch } from '../../lib/auth';

const API_BASE = 'http://127.0.0.1:3001';

export type BackboneFetcher = (input: string, init?: RequestInit) => Promise<Response>;

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
    linkAssignment: (assignmentId: number, backboneDeviceId: number, reason: string | null) => jsonMutation<BackboneAssignmentSummary>(
      fetcher, `${API_BASE}/api/topology/assignments/${assignmentId}/backbone`, 'PUT', { backboneDeviceId, reason }
    ),
    unlinkAssignment: (assignmentId: number, reason: string | null) => jsonMutation<{ assignmentId: number; backboneDeviceId: null }>(
      fetcher, `${API_BASE}/api/topology/assignments/${assignmentId}/backbone`, 'DELETE', { reason }
    )
  };
}

export type BackboneApi = ReturnType<typeof createBackboneApi>;
