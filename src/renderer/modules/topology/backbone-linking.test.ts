import { describe, expect, test, vi } from 'vitest';
import type { BackboneDeviceDetail } from '../../../shared/backbone';
import type { BackboneApi } from './backbone-api';
import {
  connectBackboneUpstream,
  disconnectBackboneUpstream,
  isValidBackboneConnection,
  parseBackboneNodeId
} from './backbone-linking';

const detail: BackboneDeviceDetail = {
  id: 7,
  catalogId: 3,
  catalogBrand: 'TP-Link',
  catalogModel: 'CPE710',
  catalogType: 'antena',
  name: 'AP Espia',
  status: 'active',
  serialNumber: 'SN-7',
  assetTag: 'AT-7',
  ipAddress: '10.0.0.7',
  macAddress: 'AA:BB:CC:00:00:07',
  island: 'Santiago',
  zone: 'Praia',
  provisional: false,
  upstreams: [],
  downstreamCount: 0,
  linkedAssignmentCount: 2,
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
  notes: 'Torre norte',
  assignments: [],
  downstream: []
};

function api(overrides: Partial<BackboneApi> = {}): BackboneApi {
  return {
    listCatalogs: vi.fn(),
    listBackbones: vi.fn(),
    listAssignments: vi.fn(),
    getBackbone: vi.fn(async () => detail),
    createBackbone: vi.fn(),
    updateBackbone: vi.fn(async () => detail),
    linkAssignment: vi.fn(),
    unlinkAssignment: vi.fn(),
    ...overrides
  } as unknown as BackboneApi;
}

describe('backbone node ids', () => {
  test('reads only well-formed backbone ids', () => {
    expect(parseBackboneNodeId('backbone:12')).toBe(12);
    expect(parseBackboneNodeId('root:isp')).toBeNull();
    expect(parseBackboneNodeId('assignment:12')).toBeNull();
    expect(parseBackboneNodeId('backbone:0')).toBeNull();
    expect(parseBackboneNodeId('backbone:abc')).toBeNull();
  });

  test('accepts only spine pairs as connections', () => {
    expect(isValidBackboneConnection('root:isp', 'backbone:7')).toBe(true);
    expect(isValidBackboneConnection('backbone:3', 'backbone:7')).toBe(true);
    expect(isValidBackboneConnection('backbone:7', 'backbone:7')).toBe(false);
    expect(isValidBackboneConnection('backbone:3', 'assignment:7')).toBe(false);
    expect(isValidBackboneConnection('assignment:3', 'backbone:7')).toBe(false);
    expect(isValidBackboneConnection(null, 'backbone:7')).toBe(false);
  });
});

describe('connectBackboneUpstream', () => {
  test('refuses an invalid pair without touching the API', async () => {
    const client = api();
    await expect(connectBackboneUpstream(client, 'backbone:7', 'assignment:9'))
      .rejects.toThrow(/Ligação inválida/);
    expect(client.getBackbone).not.toHaveBeenCalled();
    expect(client.updateBackbone).not.toHaveBeenCalled();
  });

  test('resends the read detail with the new upstream and its update stamp', async () => {
    const client = api();
    await connectBackboneUpstream(client, 'backbone:3', 'backbone:7');

    expect(client.getBackbone).toHaveBeenCalledWith(7);
    expect(client.updateBackbone).toHaveBeenCalledWith(7, {
      catalogId: 3,
      name: 'AP Espia',
      status: 'active',
      serialNumber: 'SN-7',
      assetTag: 'AT-7',
      ipAddress: '10.0.0.7',
      macAddress: 'AA:BB:CC:00:00:07',
      island: 'Santiago',
      zone: 'Praia',
      notes: 'Torre norte',
      upstreamDeviceIds: [3],
      expectedUpdatedAt: '2026-07-30T10:00:00.000Z'
    });
  });

  test('dragging from the root releases the unit to the head of the chain', async () => {
    const client = api();
    await connectBackboneUpstream(client, 'root:isp', 'backbone:7');

    expect(vi.mocked(client.updateBackbone).mock.calls[0][1].upstreamDeviceIds).toEqual([]);
  });

  test('adds a second uplink instead of replacing the first: multi-WAN sums links', async () => {
    const client = api({
      getBackbone: vi.fn(async () => ({ ...detail, upstreams: [{ id: 3, name: 'Starlink 1' }] }))
    });
    await connectBackboneUpstream(client, 'backbone:4', 'backbone:7');

    expect(vi.mocked(client.updateBackbone).mock.calls[0][1].upstreamDeviceIds).toEqual([3, 4]);
  });

  test('ignores an uplink that is already declared', async () => {
    const client = api({
      getBackbone: vi.fn(async () => ({ ...detail, upstreams: [{ id: 3, name: 'Starlink 1' }] }))
    });
    await connectBackboneUpstream(client, 'backbone:3', 'backbone:7');

    expect(vi.mocked(client.updateBackbone).mock.calls[0][1].upstreamDeviceIds).toEqual([3]);
  });

  test('disconnecting one uplink keeps the others', async () => {
    const client = api({
      getBackbone: vi.fn(async () => ({
        ...detail,
        upstreams: [{ id: 3, name: 'Starlink 1' }, { id: 4, name: 'Starlink 2' }]
      }))
    });
    await disconnectBackboneUpstream(client, 7, 3);

    expect(vi.mocked(client.updateBackbone).mock.calls[0][1].upstreamDeviceIds).toEqual([4]);
  });

  test('surfaces the server refusal as it comes', async () => {
    const client = api({
      updateBackbone: vi.fn(async () => {
        throw new Error('Esta ligação criaria um ciclo na cadeia de backbones');
      })
    });

    await expect(connectBackboneUpstream(client, 'backbone:3', 'backbone:7'))
      .rejects.toThrow('Esta ligação criaria um ciclo na cadeia de backbones');
  });
});
