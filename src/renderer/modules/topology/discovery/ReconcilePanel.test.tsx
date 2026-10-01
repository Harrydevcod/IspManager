/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BackboneDeviceDetail } from '../../../../shared/backbone';
import { ToastProvider } from '../../../components';
import { ReconcilePanel } from './ReconcilePanel';
import { createDiscoveryApi, type Proposal } from './discovery-api';

const backboneApi = vi.hoisted(() => ({
  getBackbone: vi.fn(),
  updateBackbone: vi.fn()
}));

vi.mock('../backbone-api', () => ({ createBackboneApi: () => backboneApi }));

const current: BackboneDeviceDetail = {
  id: 10,
  catalogId: 3,
  catalogBrand: 'MikroTik',
  catalogModel: 'hEX S',
  catalogType: 'router',
  name: 'Router de Gestão',
  status: 'active',
  serialNumber: 'BB-10',
  assetTag: 'RT-10',
  ipAddress: '192.168.2.1',
  macAddress: null,
  routerInterface: 'ether1',
  wanMode: 'static',
  operationMode: 'router',
  island: 'Santiago',
  zone: 'Praia',
  provisional: false,
  upstreams: [{ id: 7, name: 'Uplink' }],
  downstreamCount: 2,
  linkedAssignmentCount: 1,
  createdAt: '2026-07-29T09:00:00.000Z',
  updatedAt: '2026-07-29T10:00:00.000Z',
  notes: 'Router principal',
  assignments: [],
  downstream: []
};

const proposal: Proposal = {
  kind: 'mac_em_falta',
  targetKind: 'backbone',
  targetId: 10,
  name: current.name,
  current: null,
  proposed: '04:F4:1C:45:FD:96',
  ip: current.ipAddress!,
  serviceId: null,
  clientId: null
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  backboneApi.getBackbone.mockReset().mockResolvedValue(current);
  backboneApi.updateBackbone.mockReset().mockResolvedValue({ ...current, macAddress: proposal.proposed });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('ReconcilePanel', () => {
  async function apply(target: Proposal) {
    const api = {
      ...createDiscoveryApi(),
      patchAssignment: vi.fn(async () => ({}))
    };
    const onChanged = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ToastProvider>
          <ReconcilePanel
            data={{ proposals: [target], orphans: [] }}
            api={api}
            onChanged={onChanged}
            onOpenService={() => undefined}
            onOpenBackbone={() => undefined}
          />
        </ToastProvider>
      );
    });
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((element) => element.textContent?.trim() === 'Aplicar');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    return { api, onChanged };
  }

  test('applies a missing MAC to a backbone while preserving its full record', async () => {
    const { api, onChanged } = await apply(proposal);

    expect(backboneApi.getBackbone).toHaveBeenCalledTimes(1);
    expect(backboneApi.getBackbone).toHaveBeenCalledWith(10);
    expect(backboneApi.updateBackbone).toHaveBeenCalledTimes(1);
    expect(backboneApi.updateBackbone).toHaveBeenCalledWith(10, {
      catalogId: current.catalogId,
      name: current.name,
      status: current.status,
      serialNumber: current.serialNumber,
      assetTag: current.assetTag,
      ipAddress: current.ipAddress,
      macAddress: proposal.proposed,
      routerInterface: current.routerInterface,
      wanMode: current.wanMode,
      operationMode: current.operationMode,
      island: current.island,
      zone: current.zone,
      notes: current.notes,
      upstreamDeviceIds: [7],
      expectedUpdatedAt: current.updatedAt
    });
    expect(api.patchAssignment).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test('applies a missing MAC to an assignment through its patch route', async () => {
    const assignment = { ...proposal, targetKind: 'assignment' as const, targetId: 21 };
    const { api } = await apply(assignment);

    expect(api.patchAssignment).toHaveBeenCalledTimes(1);
    expect(api.patchAssignment).toHaveBeenCalledWith(21, {
      macAddress: proposal.proposed
    });
    expect(backboneApi.updateBackbone).not.toHaveBeenCalled();
  });
});
