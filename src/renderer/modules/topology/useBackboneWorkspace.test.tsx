/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneDeviceSummary,
  BackbonePage
} from '../../../shared/backbone';
import { BackboneApiError, type BackboneApi } from './backbone-api';
import { useBackboneWorkspace } from './useBackboneWorkspace';

const backbone: BackboneDeviceSummary = {
  id: 10, catalogId: 3, catalogBrand: 'Ubiquiti', catalogModel: 'Rocket', catalogType: 'radio',
  name: 'Monte Verde', status: 'active', serialNumber: 'BB-10', assetTag: null,
  ipAddress: '10.0.0.10', macAddress: null, island: 'São Vicente', zone: null,
  provisional: false, linkedAssignmentCount: 1,
  createdAt: '2026-07-29T10:00:00.000Z', updatedAt: '2026-07-29T10:00:00.000Z'
};

const assignment: BackboneAssignmentSummary = {
  id: 21, catalogId: 4, catalogBrand: 'MikroTik', catalogModel: 'hAP', catalogType: 'router',
  serialNumber: 'CPE-21', assetTag: null, ipAddress: null, macAddress: null,
  startDate: '2026-07-01', clientId: 1, clientCode: 'CLT-001', clientName: 'Cliente Um',
  serviceId: 2, serviceStatus: 'active', backboneDeviceId: null, backboneName: null, linkedAt: null
};

function page<T>(items: T[]): BackbonePage<T> {
  return { page: 1, pageSize: 25, total: items.length, totalPages: 1, items };
}

const detail: BackboneDeviceDetail = { ...backbone, notes: null, assignments: [] };
const writeInput = {
  catalogId: 3, name: 'Monte Verde', status: 'active' as const, serialNumber: null,
  assetTag: null, ipAddress: null, macAddress: null, island: null, zone: null, notes: null
};

function api(overrides: Partial<BackboneApi> = {}): BackboneApi {
  return {
    listBackbones: vi.fn(async () => page([backbone])),
    listAssignments: vi.fn(async () => page([assignment])),
    getBackbone: vi.fn(async () => detail),
    createBackbone: vi.fn(async () => detail),
    updateBackbone: vi.fn(async () => detail),
    linkAssignment: vi.fn(async () => ({ ...assignment, backboneDeviceId: 10, backboneName: 'Monte Verde' })),
    unlinkAssignment: vi.fn(async () => ({ assignmentId: 21, backboneDeviceId: null })),
    ...overrides
  };
}

let root: Root | null = null;
let latest: ReturnType<typeof useBackboneWorkspace> | null = null;

function Harness({ workspaceApi, onMutation = () => undefined }: {
  workspaceApi: BackboneApi;
  onMutation?: () => void;
}) {
  latest = useBackboneWorkspace(workspaceApi, onMutation);
  return null;
}

async function mount(workspaceApi = api(), onMutation = () => undefined) {
  const element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  await act(async () => {
    root?.render(<Harness workspaceApi={workspaceApi} onMutation={onMutation} />);
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return workspaceApi;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  latest = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('backbone workspace state', () => {
  test('loads independent backbone, assignment, and unlinked pages on mount', async () => {
    const workspaceApi = await mount();

    expect(workspaceApi.listBackbones).toHaveBeenCalledWith({
      page: 1, pageSize: 25, status: undefined, query: undefined
    });
    expect(workspaceApi.listAssignments).toHaveBeenNthCalledWith(1, {
      page: 1, pageSize: 25, mapping: 'all', query: undefined
    });
    expect(workspaceApi.listAssignments).toHaveBeenNthCalledWith(2, {
      page: 1, pageSize: 25, mapping: 'unlinked', query: undefined
    });
    expect(latest?.backbones.items).toEqual([backbone]);
    expect(latest?.assignments.items).toEqual([assignment]);
    expect(latest?.unlinked.items).toEqual([assignment]);
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
  });

  test('loads detail only for the currently selected backbone', async () => {
    const workspaceApi = await mount();

    await act(async () => {
      latest?.selectBackbone(10);
      await Promise.resolve();
    });

    expect(workspaceApi.getBackbone).toHaveBeenCalledWith(10);
    expect(latest?.selectedId).toBe(10);
    expect(latest?.selected).toEqual(detail);
  });

  test('debounces search and ignores a stale list response', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: BackbonePage<BackboneDeviceSummary>) => void;
    const oldPage = new Promise<BackbonePage<BackboneDeviceSummary>>((resolve) => { resolveOld = resolve; });
    const workspaceApi = api({
      listBackbones: vi.fn()
        .mockReturnValueOnce(oldPage)
        .mockResolvedValueOnce(page([{ ...backbone, name: 'Resultado novo' }]))
    });
    await mount(workspaceApi);
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(1);

    await act(async () => { latest?.setQuery('novo'); });
    await act(async () => { resolveOld(page([{ ...backbone, name: 'Resultado antigo' }])); });
    expect(latest?.backbones.items).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(2);

    expect(latest?.backbones.items[0]?.name).toBe('Resultado novo');
    vi.useRealTimers();
  });

  test('refreshes once and notifies once after a successful backbone mutation', async () => {
    const onMutation = vi.fn();
    const workspaceApi = await mount(api(), onMutation);

    await act(async () => { await latest?.createBackbone(writeInput); });

    expect(workspaceApi.createBackbone).toHaveBeenCalledWith(writeInput);
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(2);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(4);
    expect(onMutation).toHaveBeenCalledTimes(1);
    expect(latest?.mutationState.error).toBeNull();
  });

  test('preserves selected detail and exposes the server conflict after a failed update', async () => {
    const onMutation = vi.fn();
    const workspaceApi = await mount(api({
      updateBackbone: vi.fn(async () => { throw new BackboneApiError('O backbone foi alterado por outra pessoa', 409); })
    }), onMutation);
    await act(async () => { latest?.selectBackbone(10); await Promise.resolve(); });

    await act(async () => { await latest?.updateBackbone(10, writeInput); });

    expect(workspaceApi.updateBackbone).toHaveBeenCalledWith(10, writeInput);
    expect(latest?.selectedId).toBe(10);
    expect(latest?.selected).toEqual(detail);
    expect(latest?.mutationState).toMatchObject({
      pending: false, error: 'O backbone foi alterado por outra pessoa'
    });
    expect(onMutation).not.toHaveBeenCalled();
  });

  test('links selected assignments in a bounded sequence, retains partial failures, and refreshes once', async () => {
    const onMutation = vi.fn();
    let inFlight = 0;
    let maximumInFlight = 0;
    const workspaceApi = await mount(api({
      linkAssignment: vi.fn(async (assignmentId: number) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (assignmentId === 2) throw new BackboneApiError('Atribuição já foi alterada', 409);
        return { ...assignment, id: assignmentId, backboneDeviceId: 10, backboneName: 'Monte Verde' };
      })
    }), onMutation);

    await act(async () => { await latest?.linkAssignments([1, 2, 3, 4, 5], 10, 'Instalação'); });

    expect(workspaceApi.linkAssignment).toHaveBeenCalledTimes(5);
    expect(maximumInFlight).toBeLessThanOrEqual(4);
    expect(latest?.mutationState).toMatchObject({
      pending: false,
      failedAssignmentIds: [2],
      assignmentErrors: { 2: 'Atribuição já foi alterada' }
    });
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(2);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(4);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  test('transfers one assignment through the same mutation refresh path', async () => {
    const onMutation = vi.fn();
    const workspaceApi = await mount(api(), onMutation);

    await act(async () => { await latest?.transferAssignment(21, 12, 'Mudança de POP'); });

    expect(workspaceApi.linkAssignment).toHaveBeenCalledWith(21, 12, 'Mudança de POP');
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(2);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(4);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  test('unlinks an assignment and leaves no stale mutation error after success', async () => {
    const onMutation = vi.fn();
    const workspaceApi = await mount(api(), onMutation);

    await act(async () => { await latest?.unlinkAssignment(21, 'Equipamento removido'); });

    expect(workspaceApi.unlinkAssignment).toHaveBeenCalledWith(21, 'Equipamento removido');
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(2);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(4);
    expect(latest?.mutationState).toMatchObject({ pending: false, error: null });
    expect(onMutation).toHaveBeenCalledTimes(1);
  });
});
