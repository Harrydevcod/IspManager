import { describe, expect, test } from 'vitest';
import type { TopologySearchResponse } from '../../../shared/topology';
import { branchOne, snapshot } from './topologyTestFixtures';
import { createTopologyApi } from './topology-api';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('topology API', () => {
  test('loads the lazy snapshot and branch through the configured authenticated fetcher', async () => {
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      return response(url.endsWith('/clients') ? branchOne : snapshot);
    };
    const api = createTopologyApi(fetcher);

    expect(await api.fetchSnapshot()).toEqual(snapshot);
    expect(await api.fetchBranch(10)).toEqual(branchOne);
    expect(urls).toEqual([
      'http://127.0.0.1:3001/api/topology',
      'http://127.0.0.1:3001/api/topology/backbones/10/clients'
    ]);
  });

  test('encodes normalized server-side search filters', async () => {
    let requestedUrl = '';
    const result: TopologySearchResponse = {
      generatedAt: '2026-07-28T12:03:00.000Z',
      query: 'jose',
      filters: { attention: true, island: 'São Vicente' },
      results: []
    };
    const api = createTopologyApi(async (url) => {
      requestedUrl = url;
      return response(result);
    });

    expect(await api.search(' José ', {
      attention: true,
      island: 'São Vicente',
      administrativeState: 'active'
    }, 25)).toEqual(result);
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe('/api/topology/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'José',
      limit: '25',
      administrativeState: 'active',
      attention: 'true',
      island: 'São Vicente'
    });
  });

  test('surfaces the backend error without returning an invalid payload', async () => {
    const api = createTopologyApi(async () => response({ error: 'Backbone nao encontrado' }, 404));
    await expect(api.fetchBranch(999)).rejects.toThrow('Backbone nao encontrado');
  });

  test('rejects a malformed successful response instead of typing it as topology data', async () => {
    const api = createTopologyApi(async () => new Response('not-json', { status: 200 }));
    await expect(api.fetchSnapshot()).rejects.toThrow('invalid JSON');
  });
});
