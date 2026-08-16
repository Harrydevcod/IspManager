/** @vitest-environment jsdom */

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TopologySearchResponse } from '../../../shared/topology';
import { Button } from '../../components';
import { AuthProvider } from '../../lib/auth';
import { branchOne, branchTwo, deviceOne, snapshot } from './topologyTestFixtures';
import TopologyMapView from './TopologyMapView';
import TopologyModule from './TopologyModule';

const roots: Root[] = [];
const canvasNodeLookups = vi.hoisted(() => vi.fn());
const canvasFits = vi.hoisted(() => vi.fn());

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
        },
        fitView: (options?: unknown) => {
          canvasFits(options);
          return flow.fitView(options as never);
        }
      };
    }
  };
});

vi.mock('./BackboneWorkspace', () => ({
  BackboneWorkspace: ({
    onMutation,
    onViewTopology,
    prefill
  }: {
    onMutation: () => void;
    onViewTopology: (backboneDeviceId: number) => void;
    prefill?: { ipAddress: string; macAddress: string | null } | null;
  }) => (
    <section aria-label="Gestão de backbone">
      <Button onClick={onMutation}>Concluir ligação</Button>
      <Button onClick={() => onViewTopology(77)}>Ver na Topologia</Button>
      {prefill ? <p>Prefill {prefill.ipAddress}</p> : null}
    </section>
  )
}));

vi.mock('./discovery/DiscoveryWorkspace', () => ({
  DiscoveryWorkspace: ({
    onRegisterBackbone
  }: {
    onRegisterBackbone: (prefill: { ipAddress: string; macAddress: string | null }) => void;
  }) => (
    <section aria-label="Descoberta de rede">
      <Button onClick={() => onRegisterBackbone({ ipAddress: '192.168.1.42', macAddress: null })}>
        Registar como backbone
      </Button>
    </section>
  )
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * O jsdom não traz `DOMMatrixReadOnly`, que o d3-zoom lê ao enquadrar a vista.
 * Basta a identidade: os testes verificam comandos e conteúdo, não coordenadas.
 */
class DOMMatrixReadOnlyStub {
  m11 = 1;
  m22 = 1;
  m41 = 0;
  m42 = 0;
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
    root.render(<AuthProvider>{element}</AuthProvider>);
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

/**
 * O mapa desenha os controlos por portal, num slot que na aplicação vive na tira
 * das abas. Aqui o slot fica ao lado do mapa para os botões continuarem dentro
 * do contentor que os testes interrogam.
 */
function MapHarness({ topologyApi }: { topologyApi: ReturnType<typeof api> }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setSlot} />
      <TopologyMapView
        api={topologyApi}
        onOpenClient={() => undefined}
        onOpenService={() => undefined}
        onOpenStock={() => undefined}
        revision={0}
        active
        focusBackboneDeviceId={null}
        onFocusHandled={() => undefined}
        onMutation={() => undefined}
        toolsSlot={slot}
      />
    </>
  );
}

async function mountMap(topologyApi = api()): Promise<HTMLElement> {
  return mountWith(<MapHarness topologyApi={topologyApi} />);
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
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
  // A autoria no mapa corre com sessão sem restrições; catálogo e candidatos
  // a montante respondem vazio até um teste precisar deles.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return json({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/stock/summary')) return json({ rows: [] });
    return json({ page: 1, pageSize: 100, total: 0, totalPages: 0, items: [] });
  }));
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
  canvasFits.mockClear();
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

  test('arrow keys reach the third tab and wrap around', async () => {
    const container = await mountModule();
    const names = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .map((node) => node.textContent?.trim());
    expect(names).toEqual(['Backbone', 'Topologia', 'Descoberta']);

    async function arrow(from: HTMLButtonElement, key: 'ArrowRight' | 'ArrowLeft') {
      from.focus();
      await act(async () => {
        from.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        await vi.dynamicImportSettled();
      });
    }

    await arrow(tab(container, 'Backbone'), 'ArrowRight');
    await arrow(tab(container, 'Topologia'), 'ArrowRight');
    expect(tab(container, 'Descoberta').getAttribute('aria-selected')).toBe('true');

    // A envolvência é o que um alternador binário não dava: da última volta à primeira.
    await arrow(tab(container, 'Descoberta'), 'ArrowRight');
    expect(tab(container, 'Backbone').getAttribute('aria-selected')).toBe('true');

    await arrow(tab(container, 'Backbone'), 'ArrowLeft');
    expect(tab(container, 'Descoberta').getAttribute('aria-selected')).toBe('true');
  });

  test('the discovery panel stays unmounted until the tab is opened', async () => {
    const container = await mountModule();
    expect(container.textContent).not.toContain('Registar como backbone');

    await act(async () => { tab(container, 'Descoberta').click(); });
    expect(container.textContent).toContain('Registar como backbone');
  });

  test('registering a discovered address switches to Backbone carrying the prefill', async () => {
    const container = await mountModule();
    await act(async () => { tab(container, 'Descoberta').click(); });

    const register = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === 'Registar como backbone');
    await act(async () => { register?.click(); });

    expect(tab(container, 'Backbone').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent)
      .toContain('Prefill 192.168.1.42');
  });

  test('reloads the map after a management mutation without closing the open branch', async () => {
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

    // Ligar uma CPE na outra aba obriga a reler — e a releitura tem de passar
    // pelo ramo aberto, senão a CPE nova nunca lá aparecia. O que o operador
    // tinha aberto e selecionado continua aberto e selecionado.
    expect(topologyApi.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(topologyApi.fetchBranch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('CPE 100');
    expect(container.textContent).not.toContain('Seleciona um nó');
  });

  test('refetches when the map becomes visible again, to catch work done elsewhere', async () => {
    const topologyApi = api();
    const container = await mountModule(topologyApi);

    await act(async () => {
      tab(container, 'Topologia').click();
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });
    await act(async () => {
      tab(container, 'Backbone').click();
      await Promise.resolve();
    });
    await act(async () => {
      tab(container, 'Topologia').click();
      await Promise.resolve();
    });

    expect(topologyApi.fetchSnapshot).toHaveBeenCalledTimes(2);
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

  test('parks the map controls in the tab strip, and only while the map is showing', async () => {
    const container = await mountModule();
    expect(container.querySelector('.topology-tabs [role="toolbar"]')).toBeNull();

    await act(async () => {
      tab(container, 'Topologia').click();
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });

    const tools = container.querySelector('.topology-tabs [role="toolbar"]');
    expect(tools?.getAttribute('aria-label')).toBe('Controlos do mapa');
    // Fora do canvas: é isso que impede os botões de taparem o grafo.
    expect(container.querySelector('.topology-canvas-shell [role="toolbar"]')).toBeNull();

    await act(async () => { tab(container, 'Backbone').click(); });
    expect(container.querySelector('.topology-tabs [role="toolbar"]')).toBeNull();
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

  test('opens with the inspector closed and shows it on the first selection', async () => {
    const container = await mountMap();
    const inspector = () => container.querySelector('[aria-label="Inspetor da topologia"]');
    // O rótulo diz o próximo passo, por isso muda com o estado.
    const toggle = (label: string) => button(container, label);
    // O mapa arranca com toda a largura — o painel só entra quando for preciso.
    expect(inspector()).toBeNull();
    expect(toggle('Mostrar o inspetor').getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      button(container, 'Selecionar Ubiquiti Rocket Prism').click();
    });
    expect(inspector()).not.toBeNull();
    expect(toggle('Ocultar o inspetor').getAttribute('aria-pressed')).toBe('true');

    await act(async () => { toggle('Ocultar o inspetor').click(); });
    expect(inspector()).toBeNull();

    // O ✕ do cabeçalho fecha o painel e larga a seleção.
    await act(async () => { toggle('Mostrar o inspetor').click(); });
    await act(async () => { button(container, 'Fechar inspetor').click(); });
    expect(inspector()).toBeNull();
  });

  test('hides and restores the minimap and the legend from the toolbar', async () => {
    const container = await mountMap();
    const minimap = () => container.querySelector('.topology-minimap');
    const legend = () => container.querySelector('[aria-label="Legenda da topologia"]');
    // Ambos entram abertos: o mapa mostra tudo até alguém pedir espaço.
    expect(minimap()).not.toBeNull();
    expect(legend()).not.toBeNull();

    await act(async () => { button(container, 'Ocultar o mini-mapa').click(); });
    expect(minimap()).toBeNull();
    expect(legend()).not.toBeNull();
    expect(button(container, 'Mostrar o mini-mapa').getAttribute('aria-pressed')).toBe('false');

    await act(async () => { button(container, 'Ocultar a legenda').click(); });
    expect(legend()).toBeNull();

    await act(async () => { button(container, 'Mostrar o mini-mapa').click(); });
    expect(minimap()).not.toBeNull();
  });

  test('opens and closes every branch from one control, without refetching', async () => {
    const topologyApi = api();
    const container = await mountMap(topologyApi);
    expect(container.textContent).not.toContain('CPE 100');

    await act(async () => {
      button(container, 'Abrir todos os ramos').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('CPE 100');
    expect(container.textContent).toContain('CPE 200');
    expect(topologyApi.fetchBranch).toHaveBeenCalledTimes(2);

    await act(async () => { button(container, 'Fechar todos os ramos').click(); });
    expect(container.textContent).not.toContain('CPE 100');

    // Fechar não deita fora os ramos carregados.
    await act(async () => {
      button(container, 'Abrir todos os ramos').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('CPE 100');
    expect(topologyApi.fetchBranch).toHaveBeenCalledTimes(2);
  });

  test('registers a device from the map with the shared backbone form', async () => {
    const container = await mountMap();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const create = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Novo equipamento');
    if (!create) throw new Error('Create device button not found');

    await act(async () => {
      create.click();
      await Promise.resolve();
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Novo backbone');
    expect(dialog?.textContent).toContain('Alimentado por');
  });

  test('refits the view when opening every branch pushes the graph off screen', async () => {
    const container = await mountMap();
    // O enquadramento inicial já correu — conta-se só o que a abertura provoca.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });
    canvasFits.mockClear();

    await act(async () => {
      button(container, 'Abrir todos os ramos').click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });

    expect(container.textContent).toContain('CPE 100');
    expect(canvasFits).toHaveBeenCalled();
  });

  test('scopes the map to one backbone and back to the whole network', async () => {
    const container = await mountMap();
    const scope = () => {
      const select = container.querySelector<HTMLSelectElement>('[aria-label="Vista do mapa"]');
      if (!select) throw new Error('Scope select not found');
      return select;
    };
    // O nome também está nas opções do seletor: quem conta é o nó no mapa.
    const onMap = (label: string) => container.querySelector(
      `[aria-label="Selecionar ${label}"]`
    ) !== null;
    expect(onMap('MikroTik Legacy')).toBe(true);

    // Focar carrega o ramo sozinho: um backbone sem as CPEs não serve de vista.
    await act(async () => {
      const select = scope();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value'
      )?.set;
      setter?.call(select, '10');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMap('CPE 100')).toBe(true);
    expect(onMap('MikroTik Legacy')).toBe(false);
    expect(container.textContent).toContain('Vista:');

    // O chip devolve a rede completa.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.topology-scope-chip')?.click();
    });
    expect(onMap('MikroTik Legacy')).toBe(true);
  });

  test('turns the map between the two drawing directions', async () => {
    const container = await mountMap();

    // Arranca de cima para baixo, por isso o botão oferece o outro desenho.
    await act(async () => {
      button(container, 'Desenhar da esquerda para a direita').click();
    });
    expect(button(container, 'Desenhar de cima para baixo')).toBeTruthy();

    await act(async () => {
      button(container, 'Desenhar de cima para baixo').click();
    });
    expect(button(container, 'Desenhar da esquerda para a direita')).toBeTruthy();
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
    button(container, 'Mostrar as etiquetas das ligações').click();
  });

  expect(button(container, 'Ocultar as etiquetas das ligações').getAttribute('aria-pressed'))
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

  expect(container.querySelector('[aria-label="Mapa físico da rede"]')).not.toBeNull();
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
