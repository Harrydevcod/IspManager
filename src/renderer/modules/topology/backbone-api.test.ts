import { describe, expect, test } from 'vitest';
import type { BackbonePage, BackboneDeviceSummary, BackboneWriteInput } from '../../../shared/backbone';
import { BackboneApiError, createBackboneApi } from './backbone-api';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const emptyBackbones: BackbonePage<BackboneDeviceSummary> = {
  page: 1, pageSize: 25, total: 0, totalPages: 0, items: []
};

describe('backbone management API', () => {
  test('loads only active equipment catalogs with factual brand and model labels', async () => {
    const api = createBackboneApi(async (url) => response({
      totals: {},
      rows: [
        { id: 7, category: 'equipamento', brand: 'Ubiquiti', model: 'Rocket', type: 'antena', active: 1 },
        { id: 8, category: 'material', brand: null, model: 'Cabo CAT6', type: 'cabo', active: 1 },
        { id: 9, category: 'equipamento', brand: 'MikroTik', model: 'CCR', type: 'router', active: 0 }
      ],
      url
    }));

    await expect(api.listCatalogs()).resolves.toEqual([
      { id: 7, brand: 'Ubiquiti', model: 'Rocket', type: 'antena' }
    ]);
  });

  test('serializes independent backbone and assignment list filters for the approved routes', async () => {
    const calls: string[] = [];
    const api = createBackboneApi(async (url) => {
      calls.push(url);
      return response(emptyBackbones);
    });

    await api.listBackbones({ page: 1, pageSize: 25, status: 'active', query: 'rocket' });
    await api.listAssignments({ page: 1, pageSize: 25, mapping: 'unlinked', query: 'cliente' });

    expect(calls[0]).toBe(
      'http://127.0.0.1:3001/api/topology/backbones?page=1&pageSize=25&status=active&query=rocket'
    );
    expect(calls[1]).toBe(
      'http://127.0.0.1:3001/api/topology/assignments?page=1&pageSize=25&mapping=unlinked&query=cliente'
    );
  });

  test('sends JSON management mutations and exposes typed backend errors', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const input: BackboneWriteInput = {
      catalogId: 7, name: 'Monte Verde', status: 'active', serialNumber: null,
      assetTag: null, ipAddress: null, macAddress: null, island: null, zone: null,
      notes: 'Core', upstreamDeviceIds: [], expectedUpdatedAt: '2026-07-29T10:00:00.000Z'
    };
    const api = createBackboneApi(async (url, init) => {
      requests.push({ url, init });
      return response({ error: 'O backbone foi alterado por outra pessoa' }, 409);
    });

    await expect(api.updateBackbone(12, input)).rejects.toEqual(
      expect.objectContaining<Partial<BackboneApiError>>({
        message: 'O backbone foi alterado por outra pessoa', status: 409
      })
    );
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:3001/api/topology/backbones/12',
      init: {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }
    }]);
  });

  test('uses the approved create, link, and unlink contracts', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const input: BackboneWriteInput = {
      catalogId: 7, name: 'Monte Verde', status: 'active', serialNumber: null,
      assetTag: null, ipAddress: null, macAddress: null, island: null, zone: null,
      notes: null, upstreamDeviceIds: []
    };
    const api = createBackboneApi(async (url, init) => {
      requests.push({ url, init });
      return response({ assignmentId: 21, backboneDeviceId: null });
    });

    await api.createBackbone(input);
    await api.linkAssignment(21, 12, 'Instalação');
    await api.unlinkAssignment(21, 'Removido');

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:3001/api/topology/backbones',
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
      },
      {
        url: 'http://127.0.0.1:3001/api/topology/assignments/21/backbone',
        init: {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backboneDeviceId: 12, reason: 'Instalação' })
        }
      },
      {
        url: 'http://127.0.0.1:3001/api/topology/assignments/21/backbone',
        init: { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Removido' }) }
      }
    ]);
  });
});
