/** @vitest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TopologySearchResponse } from '../../../shared/topology';
import { Button } from '../../components';
import { branchOne, branchTwo, deviceOne, snapshot } from './topologyTestFixtures';
import TopologyMapView from './TopologyMapView';
import TopologyModule from './TopologyModule';

const roots: Root[] = [];
const canvasNodeLookups = vi.hoisted(() => vi.fn());

vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...original,
    useReactFlow: () => {
      const flow = original.useReactFlow();
      return {
        ...flow,
        getNode: (nodeId: string) => {
          canvasNodeLookups(nodeId);
          return flow.getNode(nodeId);
        }
      };
    }
  };
});

vi.mock('./BackboneWorkspace', () => ({
  BackboneWorkspace: ({
    onMutation,
    onViewTopology
  }: {
    onMutation: () => void;
    onViewTopology: (backboneDeviceId: number) => void;
  }) => (
    <section aria-label="Gestão de backbone">
      <Button onClick={onMutation}>Concluir ligação</Button>
      <Button onClick={() => onViewTopology(77)}>Ver na Topologia</Button>
    </section>
  )
}));

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
        { id: 'root:isp', kind: 'logical-root', label: 'Internet' },
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

async function mountWith(
  element: ReactNode
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

async function mountModule(topologyApi = api()): Promise<HTMLElement> {
  return mountWith(
    <TopologyModule
      api={topologyApi}
      onOpenClient={() => undefined}
      onOpenService={() => undefined}
      onOpenStock={() => undefined}
    />
  );
}

async function mountMap(topologyApi = api()): Promise<HTMLElement> {
  return mountWith(
    <TopologyMapView
        api={topologyApi}
        onOpenClient={() => undefined}
        onOpenService={() => undefined}
        onOpenStock={() => undefined}
      revision={0}
      active
      focusBackboneDeviceId={null}
      onFocusHandled={() => undefined}
    />
  );
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.getAttribute('aria-label') === name);
  if (!result) throw new Error(`Button not found: ${name}`);
  return result;
}

function tab(container: HTMLElement, name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!result) throw new Error(`Tab not found: ${name}`);
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
  canvasNodeLookups.mockClear();
});

afterEach(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TopologyModule tab shell', () => {
  test('opens Backbone as the first selected tab', async () => {
    const container = await mountModule();

    expect(tab(container, 'Backbone').getAttribute('aria-selected')).toBe('true');
    expect(tab(container, 'Topologia').getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent)
      .toContain('Concluir ligação');
  });

  test('moves selection and keyboard focus with horizontal arrow keys', async () => {
    const container = await mountModule();
    const backboneTab = tab(container, 'Backbone');
    const topologyTab = tab(container, 'Topologia');
    backboneTab.focus();

    await act(async () => {
      backboneTab.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true
      }));
      await vi.dynamicImportSettled();
    });

    expect(topologyTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(topologyTab);

    await act(async () => {
      topologyTab.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true
      }));
    });

    expect(backboneTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(backboneTab);
  });

  test('invalidates loaded map state only after a successful management mutation', async () => {
    const topologyApi = api();
    const container = await mountModule(topologyApi);

    await act(async () => {
      tab(container, 'Topologia').click();
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });
    expect(topologyApi.fetchSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      button(container, 'Expandir ramo Ubiquiti Rocket Prism').click();
      await Promise.resolve();
      button(container, 'Selecionar Ubiquiti Rocket Prism').click();
      tab(container, 'Backbone').click();
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Concluir ligação')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      tab(container, 'Topologia').click();
      await Promise.resolve();
    });

    expect(topologyApi.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('CPE 100');
    expect(container.textContent).toContain('Seleciona um nó');
  });

  test('keeps one loaded snapshot across ordinary tab round trips', async () => {
    const topologyApi = api();
    const container = await mountModule(topologyApi);

    await act(async () => {
      tab(container, 'Topologia').click();
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });
    await act(async () => {
      tab(container, 'Backbone').click();
      tab(container, 'Topologia').click();
      await Promise.resolve();
    });

    expect(topologyApi.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  test('preserves map selection when Escape is pressed from the Backbone tab', async () => {
    const container = await mountModule();

    await act(async () => {
      tab(container, 'Topologia').click();
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });
    await act(async () => {
      button(container, 'Selecionar Ubiquiti Rocket Prism').click();
      tab(container, 'Backbone').click();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      tab(container, 'Topologia').click();
    });

    expect(container.textContent).toContain('Equipamento backbone');
  });

  test('opens Topologia and focuses the requested physical backbone after lazy load', async () => {
    const focusedSnapshot = {
      ...snapshot,
      backbones: [{
        ...snapshot.backbones[0],
        id: 'backbone:77' as const,
        backboneDeviceId: 77,
        catalogId: 10,
        label: 'Backbone físico Fogo'
      }],
      edges: [{
        ...snapshot.edges[0],
        id: 'core-link:root:isp:backbone:77' as const,
        target: 'backbone:77' as const
      }]
    };
    const container = await mountModule(api({
      fetchSnapshot: vi.fn(async () => focusedSnapshot)
    }));

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Ver na Topologia')
        ?.click();
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });

    expect(tab(container, 'Topologia').getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('Equipamento backbone');
    expect(container.textContent).toContain('Backbone físico Fogo');
    expect(canvasNodeLookups).toHaveBeenCalledWith('backbone:77');
  });
});

describe('TopologyModule branch interaction', () => {
  test('loads a physical backbone branch once even when its catalog id differs', async () => {
    const physicalBackbone = {
      ...snapshot.backbones[0],
      id: 'backbone:77' as const,
      backboneDeviceId: 77,
      catalogId: 10
    };
    const physicalSnapshot = {
      ...snapshot,
      backbones: [physicalBackbone, snapshot.backbones[1]],
      edges: [
        {
          ...snapshot.edges[0],
          id: 'core-link:root:isp:backbone:77' as const,
          target: 'backbone:77' as const
        },
        snapshot.edges[1]
      ]
    };
    const physicalBranch = {
      ...branchOne,
      backbone: physicalBackbone,
      nodes: [{
        ...branchOne.nodes[0],
        parentId: 'backbone:77' as const
      }],
      edges: [{
        ...branchOne.edges[0],
        id: 'client-link:backbone:77:assignment:100' as const,
        source: 'backbone:77' as const
      }]
    };
    const topologyApi = api({
      fetchSnapshot: vi.fn(async () => physicalSnapshot),
      fetchBranch: vi.fn(async (id: number) => id === 77 ? physicalBranch : branchTwo)
    });
    const container = await mountMap(topologyApi);
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
    expect(topologyApi.fetchBranch).toHaveBeenCalledWith(77);
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
    const container = await mountMap(topologyApi);

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
  const container = await mountMap(topologyApi);
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
          label: 'Internet'
        }]
      }]
    }))
  });
  const container = await mountMap(topologyApi);
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

test('surfaces the number of CPE assignments without a defined backbone link', async () => {
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
  const container = await mountMap(topologyApi);

  expect(container.textContent).toContain('CPE ligadas2');
  expect(container.textContent).toContain('Sem ligação2');
});

test('identifies a search result that has no defined backbone link', async () => {
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
          label: 'Internet'
        }]
      }]
    }))
  });
  const container = await mountMap(topologyApi);
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

  expect(container.textContent).toContain('CPE física · sem ligação definida');
  vi.useRealTimers();
});

test('describes rendered relationships as defined links', async () => {
  const container = await mountMap();

  expect(container.textContent).toContain('Ligação definida');
  expect(container.textContent).not.toContain('Linhagem de inventário');

  await act(async () => {
    button(container, 'Alternar etiquetas das ligações').click();
  });

  expect(button(container, 'Alternar etiquetas das ligações').getAttribute('aria-pressed'))
    .toBe('true');
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
  const container = await mountMap(topologyApi);
  expect(container.textContent).toContain('Não foi possível abrir a topologia');
  const retry = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes('Tentar novamente'));
  if (!retry) throw new Error('Global retry not found');

  await act(async () => {
    retry.click();
    await Promise.resolve();
  });

  expect(container.textContent).toContain('Mapa físico');
  expect(topologyApi.fetchSnapshot).toHaveBeenCalledTimes(2);
});

test('closes the inspector with Escape while preserving the graph', async () => {
  const container = await mountMap();
  await act(async () => {
    button(container, 'Selecionar Ubiquiti Rocket Prism').click();
  });
  expect(container.textContent).toContain('Equipamento backbone');

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  expect(container.textContent).toContain('Seleciona um nó');
  expect(container.textContent).toContain('Ubiquiti Rocket Prism');
});
