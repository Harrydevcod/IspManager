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
  provisional: false, upstreamDeviceId: null, upstreamName: null, linkedAssignmentCount: 1,
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
  assetTag: null, ipAddress: null, macAddress: null, island: null, zone: null, notes: null,
  upstreamDeviceId: null
};

function api(overrides: Partial<BackboneApi> = {}): BackboneApi {
  return {
    listCatalogs: vi.fn(async () => [
      { id: 3, brand: 'Ubiquiti', model: 'Rocket', type: 'antena' }
    ]),
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

  test('loads linked assignments from their own server collection for the selected backbone', async () => {
    const workspaceApi = await mount();
    vi.mocked(workspaceApi.listAssignments).mockClear();

    await act(async () => {
      latest?.selectBackbone(10);
      await Promise.resolve();
    });

    expect(workspaceApi.listAssignments).toHaveBeenCalledWith({
      page: 1,
      pageSize: 25,
      mapping: 'linked',
      backboneDeviceId: 10,
      query: undefined
    });
    expect(latest?.linked.items).toEqual([assignment]);
  });

  test('debounces search and ignores a stale list response', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: BackbonePage<BackboneDeviceSummary>) => void;
    const oldPage = new Promise<BackbonePage<BackboneDeviceSummary>>((resolve) => { resolveOld = resolve; });
    let masterRequest = 0;
    const workspaceApi = api({
      listBackbones: vi.fn((query) => {
        if (query.status === 'active') return Promise.resolve(page([backbone]));
        masterRequest += 1;
        return masterRequest === 1
          ? oldPage
          : Promise.resolve(page([{ ...backbone, name: 'Resultado novo' }]));
      })
    });
    await mount(workspaceApi);
    const masterCalls = () => vi.mocked(workspaceApi.listBackbones).mock.calls
      .filter(([query]) => query.status === undefined);
    expect(masterCalls()).toHaveLength(1);

    await act(async () => { latest?.setBackboneQuery('novo'); });
    await act(async () => { resolveOld(page([{ ...backbone, name: 'Resultado antigo' }])); });
    expect(latest?.backbones.items).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(masterCalls()).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(masterCalls()).toHaveLength(2);

    expect(latest?.backbones.items[0]?.name).toBe('Resultado novo');
    vi.useRealTimers();
  });

  test('keeps backbone, linked-assignment, and unlinked queries independent', async () => {
    vi.useFakeTimers();
    const workspaceApi = await mount();
    vi.mocked(workspaceApi.listBackbones).mockClear();
    vi.mocked(workspaceApi.listAssignments).mockClear();

    await act(async () => {
      latest?.setBackboneQuery('core');
      latest?.setBackboneStatusFilter('maintenance');
      latest?.setAssignmentQuery('cliente ligado');
      latest?.setUnlinkedQuery('sem POP');
    });
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });

    expect(workspaceApi.listBackbones).toHaveBeenCalledWith({
      page: 1, pageSize: 25, status: 'maintenance', query: 'core'
    });
    expect(workspaceApi.listAssignments).toHaveBeenNthCalledWith(1, {
      page: 1, pageSize: 25, mapping: 'all', query: 'cliente ligado'
    });
    expect(workspaceApi.listAssignments).toHaveBeenNthCalledWith(2, {
      page: 1, pageSize: 25, mapping: 'unlinked', query: 'sem POP'
    });
    expect(latest).toMatchObject({
      backboneQuery: 'core',
      backboneStatusFilter: 'maintenance',
      assignmentQuery: 'cliente ligado',
      unlinkedQuery: 'sem POP'
    });
    vi.useRealTimers();
  });

  test('keeps query and setQuery as backbone-query compatibility aliases', async () => {
    vi.useFakeTimers();
    const workspaceApi = await mount();
    vi.mocked(workspaceApi.listBackbones).mockClear();

    await act(async () => { latest?.setQuery('compatível'); });
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });

    expect(latest?.query).toBe('compatível');
    expect(latest?.backboneQuery).toBe('compatível');
    expect(workspaceApi.listBackbones).toHaveBeenCalledWith({
      page: 1, pageSize: 25, status: undefined, query: 'compatível'
    });
    vi.useRealTimers();
  });

  test('refreshes once and notifies once after a successful backbone mutation', async () => {
    const onMutation = vi.fn();
    const workspaceApi = await mount(api(), onMutation);

    await act(async () => { await latest?.createBackbone(writeInput); });

    expect(workspaceApi.createBackbone).toHaveBeenCalledWith(writeInput);
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(4);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(5);
    expect(workspaceApi.listAssignments).toHaveBeenCalledWith({
      page: 1, pageSize: 25, mapping: 'linked', backboneDeviceId: 10, query: undefined
    });
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
      pending: false,
      error: 'O backbone foi alterado por outra pessoa',
      conflict: {
        status: 409,
        operation: 'updateBackbone',
        message: 'O backbone foi alterado por outra pessoa',
        context: { id: 10, input: writeInput }
      }
    });
    expect(onMutation).not.toHaveBeenCalled();
  });

  test('retains typed actionable context for a non-conflict mutation failure', async () => {
    const workspaceApi = await mount(api({
      createBackbone: vi.fn(async () => { throw new BackboneApiError('Dados de backbone inválidos', 400); })
    }));

    await act(async () => { await latest?.createBackbone(writeInput); });

    expect(workspaceApi.createBackbone).toHaveBeenCalledWith(writeInput);
    expect(latest?.mutationState).toMatchObject({
      pending: false,
      error: 'Dados de backbone inválidos',
      failure: {
        status: 400,
        operation: 'createBackbone',
        message: 'Dados de backbone inválidos',
        context: { input: writeInput }
      },
      conflict: null
    });
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
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(4);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(4);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  test('retains every bulk-link failure in input order when a faster failure is a conflict', async () => {
    const workspaceApi = await mount(api({
      linkAssignment: vi.fn(async (assignmentId: number) => {
        if (assignmentId === 1) {
          await Promise.resolve();
          throw new BackboneApiError('Primeira falha', 400);
        }
        if (assignmentId === 2) throw new BackboneApiError('Conflito rápido', 409);
        throw new BackboneApiError('Terceira falha', 404);
      })
    }));

    await act(async () => { await latest?.linkAssignments([1, 2, 3], 10, 'Instalação'); });

    expect(latest?.mutationState).toMatchObject({
      failedAssignmentIds: [1, 2, 3],
      assignmentFailures: {
        1: { status: 400, operation: 'linkAssignments', message: 'Primeira falha' },
        2: {
          status: 409,
          operation: 'linkAssignments',
          message: 'Conflito rápido',
          context: { assignmentId: 2, assignmentIds: [1, 2, 3], backboneDeviceId: 10, reason: 'Instalação' }
        },
        3: { status: 404, operation: 'linkAssignments', message: 'Terceira falha' }
      },
      conflicts: [{
        status: 409,
        operation: 'linkAssignments',
        message: 'Conflito rápido',
        context: { assignmentId: 2, assignmentIds: [1, 2, 3], backboneDeviceId: 10, reason: 'Instalação' }
      }]
    });
    expect(latest?.mutationState.conflict).toMatchObject({ message: 'Conflito rápido' });
  });

  test('transfers one assignment through the same mutation refresh path', async () => {
    const onMutation = vi.fn();
    const workspaceApi = await mount(api(), onMutation);

    await act(async () => { await latest?.transferAssignment(21, 12, 'Mudança de POP'); });

    expect(workspaceApi.linkAssignment).toHaveBeenCalledWith(21, 12, 'Mudança de POP');
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(4);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(4);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  test('preserves transfer-specific conflict context', async () => {
    const workspaceApi = await mount(api({
      linkAssignment: vi.fn(async () => { throw new BackboneApiError('A ligação mudou', 409); })
    }));

    await act(async () => { await latest?.transferAssignment(21, 12, 'Mudança de POP'); });

    expect(latest?.mutationState.conflict).toMatchObject({
      status: 409,
      operation: 'transferAssignment',
      message: 'A ligação mudou',
      context: { assignmentId: 21, backboneDeviceId: 12, reason: 'Mudança de POP' }
    });
    expect(workspaceApi.linkAssignment).toHaveBeenCalledWith(21, 12, 'Mudança de POP');
  });

  test('unlinks an assignment and leaves no stale mutation error after success', async () => {
    const onMutation = vi.fn();
    const workspaceApi = await mount(api(), onMutation);

    await act(async () => { await latest?.unlinkAssignment(21, 'Equipamento removido'); });

    expect(workspaceApi.unlinkAssignment).toHaveBeenCalledWith(21, 'Equipamento removido');
    expect(workspaceApi.listBackbones).toHaveBeenCalledTimes(4);
    expect(workspaceApi.listAssignments).toHaveBeenCalledTimes(4);
    expect(latest?.mutationState).toMatchObject({ pending: false, error: null });
    expect(onMutation).toHaveBeenCalledTimes(1);
  });
});
