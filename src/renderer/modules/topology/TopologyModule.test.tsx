/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TopologySearchResponse } from '../../../shared/topology';
import { branchOne, branchTwo, deviceOne, snapshot } from './topologyTestFixtures';
import TopologyModule from './TopologyModule';

const roots: Root[] = [];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function responseSearch(): TopologySearchResponse {
  return {
    generatedAt: snapshot.generatedAt,
    query: 'cliente',
    filters: {},
    results: [{
      node: deviceOne,
      matchedFields: ['clientName'],
      ancestors: [
        { id: 'root:isp', kind: 'logical-root', label: 'Internet / Core ISPM' },
        {
          id: 'backbone:10',
          kind: 'backbone',
          label: branchOne.backbone.label,
          relationship: 'defined_link'
        }
      ]
    }]
  };
}

function api(overrides: Partial<{
  fetchSnapshot: () => Promise<typeof snapshot>;
  fetchBranch: (id: number) => Promise<typeof branchOne>;
  search: () => Promise<TopologySearchResponse>;
}> = {}) {
  return {
    fetchSnapshot: vi.fn(async () => snapshot),
    fetchBranch: vi.fn(async (id: number) => id === 10 ? branchOne : branchTwo),
    search: vi.fn(async () => responseSearch()),
    ...overrides
  };
}

async function mount(topologyApi = api()): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <TopologyModule
        api={topologyApi}
        onOpenClient={() => undefined}
        onOpenService={() => undefined}
        onOpenStock={() => undefined}
      />
    );
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.getAttribute('aria-label') === name);
  if (!result) throw new Error(`Button not found: ${name}`);
  return result;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 700,
    width: 1200, height: 700, toJSON: () => ({})
  });
});

afterEach(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TopologyModule branch interaction', () => {
  test('starts collapsed and reuses the cached branch after collapse', async () => {
    const topologyApi = api();
    const container = await mount(topologyApi);
    expect(container.textContent).not.toContain('CPE 100');

    await act(async () => {
      button(container, 'Expandir ramo Ubiquiti Rocket Prism').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('CPE 100');

    await act(async () => {
      button(container, 'Recolher ramo Ubiquiti Rocket Prism').click();
    });
    expect(container.textContent).not.toContain('CPE 100');

    await act(async () => {
      button(container, 'Expandir ramo Ubiquiti Rocket Prism').click();
      await Promise.resolve();
    });
    expect(topologyApi.fetchBranch).toHaveBeenCalledTimes(1);
  });

  test('keeps one failed branch isolated and retries only that branch', async () => {
    let secondAttempts = 0;
    const topologyApi = api({
      fetchBranch: vi.fn(async (id: number) => {
        if (id === 10) return branchOne;
        secondAttempts += 1;
        if (secondAttempts === 1) throw new Error('offline');
        return branchTwo;
      })
    });
    const container = await mount(topologyApi);

    await act(async () => {
      button(container, 'Expandir ramo Ubiquiti Rocket Prism').click();
      button(container, 'Expandir ramo MikroTik Legacy').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('CPE 100');
    expect(container.textContent).toContain('Não foi possível carregar este ramo.');

    await act(async () => {
      button(container, 'Tentar novamente MikroTik Legacy').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('CPE 100');
    expect(container.textContent).toContain('CPE 200');
    expect(secondAttempts).toBe(2);
  });
});

test('debounces server search, expands ancestors and opens the result inspector', async () => {
  vi.useFakeTimers();
  const topologyApi = api();
  const container = await mount(topologyApi);
  const search = container.querySelector<HTMLInputElement>(
    '[aria-label="Pesquisar na topologia"]'
  );
  if (!search) throw new Error('Search input not found');
  const setSearchValue = (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    setter?.call(search, value);
    search.dispatchEvent(new Event('input', { bubbles: true }));
  };

  await act(async () => {
    setSearchValue('c');
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  expect(topologyApi.search).not.toHaveBeenCalled();

  await act(async () => {
    setSearchValue('cliente');
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
    await Promise.resolve();
  });
  const result = button(container, 'Selecionar resultado CPE 100');
  await act(async () => {
    result.click();
    await Promise.resolve();
  });

  expect(topologyApi.search).toHaveBeenCalledOnce();
  expect(topologyApi.fetchBranch).toHaveBeenCalledWith(10);
  expect(container.textContent).toContain('Equipamento de cliente');
  expect(container.textContent).toContain('SN-100');
  expect(search.value).toBe('');
  vi.useRealTimers();
});

test('expands and loads a backbone selected from server search', async () => {
  vi.useFakeTimers();
  const topologyApi = api({
    search: vi.fn(async (): Promise<TopologySearchResponse> => ({
      generatedAt: snapshot.generatedAt,
      query: 'rocket',
      filters: {},
      results: [{
        node: branchOne.backbone,
        matchedFields: ['backbone'],
        ancestors: [{
          id: 'root:isp',
          kind: 'logical-root',
          label: 'Internet / Core ISPM'
        }]
      }]
    }))
  });
  const container = await mount(topologyApi);
  const search = container.querySelector<HTMLInputElement>(
    '[aria-label="Pesquisar na topologia"]'
  );
  if (!search) throw new Error('Search input not found');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;

  await act(async () => {
    setter?.call(search, 'rocket');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
    await Promise.resolve();
  });
  await act(async () => {
    button(container, 'Selecionar resultado Ubiquiti Rocket Prism').click();
    await Promise.resolve();
  });

  expect(topologyApi.fetchBranch).toHaveBeenCalledWith(10);
  expect(button(container, 'Recolher ramo Ubiquiti Rocket Prism')).toBeTruthy();
  expect(container.textContent).toContain('CPE 100');
  vi.useRealTimers();
});

test('surfaces the number of CPE assignments without backbone lineage', async () => {
  const topologyApi = api({
    fetchSnapshot: vi.fn(async () => ({
      ...snapshot,
      stats: {
        ...snapshot.stats,
        assignmentCount: 4,
        mappedAssignmentCount: 2,
        unmappedAssignmentCount: 2
      }
    }))
  });
  const container = await mount(topologyApi);

  expect(container.textContent).toContain('CPE mapeadas2');
  expect(container.textContent).toContain('Sem linhagem2');
});

test('identifies a search result that has no factual backbone lineage', async () => {
  vi.useFakeTimers();
  const unmappedDevice = {
    ...deviceOne,
    parentId: 'root:isp' as const,
    relationship: undefined
  };
  const topologyApi = api({
    search: vi.fn(async (): Promise<TopologySearchResponse> => ({
      generatedAt: snapshot.generatedAt,
      query: 'cliente',
      filters: {},
      results: [{
        node: unmappedDevice,
        matchedFields: ['clientName'],
        ancestors: [{
          id: 'root:isp',
          kind: 'logical-root',
          label: 'Internet / Core ISPM'
        }]
      }]
    }))
  });
  const container = await mount(topologyApi);
  const search = container.querySelector<HTMLInputElement>(
    '[aria-label="Pesquisar na topologia"]'
  );
  if (!search) throw new Error('Search input not found');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;

  await act(async () => {
    setter?.call(search, 'cliente');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
    await Promise.resolve();
  });

  expect(container.textContent).toContain('CPE física · sem linhagem');
  vi.useRealTimers();
});

test('recovers the global snapshot after an explicit retry', async () => {
  let attempts = 0;
  const topologyApi = api({
    fetchSnapshot: vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return snapshot;
    })
  });
  const container = await mount(topologyApi);
  expect(container.textContent).toContain('Não foi possível abrir a topologia');
  const retry = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes('Tentar novamente'));
  if (!retry) throw new Error('Global retry not found');

  await act(async () => {
    retry.click();
    await Promise.resolve();
  });

  expect(container.textContent).toContain('Mapa de inventário');
  expect(topologyApi.fetchSnapshot).toHaveBeenCalledTimes(2);
});

test('closes the inspector with Escape while preserving the graph', async () => {
  const container = await mount();
  await act(async () => {
    button(container, 'Selecionar Ubiquiti Rocket Prism').click();
  });
  expect(container.textContent).toContain('Agrupamento backbone');

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  expect(container.textContent).toContain('Seleciona um nó');
  expect(container.textContent).toContain('Ubiquiti Rocket Prism');
});
