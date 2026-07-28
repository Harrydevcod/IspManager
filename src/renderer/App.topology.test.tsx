/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App, sectionIdsForRole } from './App';
import {
  branchOne,
  snapshot
} from './modules/topology/topologyTestFixtures';
import type { ServiceRow } from './types';

let root: Root | null = null;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

const dashboard = {
  totalClients: 0,
  activeClients: 0,
  suspendedClients: 0,
  cancelledClients: 0,
  overduePayments: 0,
  pendingPayments: 0,
  lowStockModels: 0,
  activeServices: 0,
  openWorkOrders: 0,
  paidMonthCve: 0,
  paidPrevMonthCve: 0,
  pendingMonthCve: 0,
  pendingMonthCount: 0,
  pendingPreviousCve: 0,
  paidTotalCve: 0,
  revenueByMonth: [],
  upcomingDues: [],
  criticalOverdue: [],
  planMix: [],
  workQueue: []
};

const services: ServiceRow[] = [
  {
    id: 10,
    clientId: 1,
    clientName: 'Cliente 1',
    planId: 1,
    planName: 'Plano inicial',
    monthlyValueCve: 3000,
    dueDay: 1,
    status: 'active',
    activationDate: '2026-01-01',
    technicalNotes: null,
    audiovisualMode: 'none',
    audiovisualMonthlyCve: 0,
    audiovisualAnnualCve: 0,
    deviceIps: null
  },
  {
    id: 11,
    clientId: 1,
    clientName: 'Cliente 1',
    planId: 2,
    planName: 'Plano alvo',
    monthlyValueCve: 5000,
    dueDay: 10,
    status: 'active',
    activationDate: '2026-02-01',
    technicalNotes: null,
    audiovisualMode: 'none',
    audiovisualMonthlyCve: 0,
    audiovisualAnnualCve: 0,
    deviceIps: null
  }
];

const branchWithTwoServices = {
  ...branchOne,
  nodes: [{
    ...branchOne.nodes[0],
    clients: [{
      ...branchOne.nodes[0].clients[0],
      services: [
        branchOne.nodes[0].clients[0].services[0],
        {
          ...branchOne.nodes[0].clients[0].services[0],
          id: 11,
          planId: 2,
          planName: 'Plano alvo'
        }
      ]
    }]
  }],
  stats: { ...branchOne.stats, serviceCount: 2 }
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })));
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return json({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/dashboard/summary')) return json(dashboard);
    if (url.endsWith('/api/topology')) return json(snapshot);
    if (url.endsWith('/api/topology/backbones/10/clients')) {
      return json(branchWithTwoServices);
    }
    if (url.endsWith('/api/services')) return json(services);
    if (url.endsWith('/api/clients') || url.endsWith('/api/plans')) return json([]);
    if (url.endsWith('/api/audiovisual-config')) {
      return json({ enabled: false, label: '', monthlyCve: 0, annualCve: 0 });
    }
    if (url.endsWith('/api/services/11/technical-history')) {
      return json({
        serviceId: 11,
        assignments: [],
        materials: [],
        installCosts: [],
        events: []
      });
    }
    return json({});
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('topology App integration', () => {
  test.each(['admin', 'operator', 'technician'] as const)(
    'places Topologia after Servicos for %s',
    (role) => {
      const ids = sectionIdsForRole(role);
      expect(ids[ids.indexOf('services') + 1]).toBe('topology');
    }
  );

  test('loads the real topology module only after its sidebar action', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
      await Promise.resolve();
    });
    const topologyButton = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Topologia');
    if (!topologyButton) throw new Error('Topologia sidebar action not found');

    expect(container.textContent).not.toContain('Mapa de inventário');
    await act(async () => {
      topologyButton.click();
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (container.textContent?.includes('Mapa de inventário')) break;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }

    expect(container.textContent).toContain('Mapa de inventário');
  });

  test('opens the exact service selected from a CPE with multiple services', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
      await Promise.resolve();
    });
    const findButton = (label: string) => [...document.querySelectorAll('button')]
      .find((candidate) => candidate.getAttribute('aria-label') === label);
    const topologyButton = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Topologia');
    if (!topologyButton) throw new Error('Topologia sidebar action not found');

    await act(async () => topologyButton.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (findButton('Expandir ramo Ubiquiti Rocket Prism')) break;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }
    const expand = findButton('Expandir ramo Ubiquiti Rocket Prism');
    if (!expand) throw new Error('Backbone expand action not found');
    await act(async () => {
      expand.click();
      await Promise.resolve();
    });
    const selectDevice = findButton('Selecionar CPE 100');
    if (!selectDevice) throw new Error('CPE select action not found');
    await act(async () => selectDevice.click());
    const serviceActions = [...container.querySelectorAll('button')]
      .filter((candidate) => candidate.textContent?.trim() === 'Abrir serviço');
    if (serviceActions.length !== 2) throw new Error('Expected two service actions');

    await act(async () => {
      serviceActions[1].click();
      await Promise.resolve();
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ([...document.querySelectorAll('[role="dialog"]')]
        .some((candidate) => candidate.textContent?.includes('Plano alvo'))) break;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }

    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((candidate) => candidate.textContent?.includes('Plano alvo'));
    expect(dialog?.textContent).toContain('Plano alvo');
    expect(dialog?.textContent).not.toContain('Plano inicial');
  });
});
