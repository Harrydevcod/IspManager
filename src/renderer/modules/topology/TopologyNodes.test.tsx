/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { backboneOne, backboneTwo } from './topologyTestFixtures';
import { TopologyNodeContent } from './TopologyNodes';

let root: Root | null = null;

async function mount(expanded = false, branchCount?: number) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const onSelect = vi.fn();
  const onToggle = vi.fn();
  await act(async () => {
    root?.render(
      <TopologyNodeContent
        node={backboneOne}
        selected={false}
        expanded={expanded}
        loading={false}
        branchCount={branchCount}
        onSelect={onSelect}
        onToggle={onToggle}
      />
    );
  });
  return { container, onSelect, onToggle };
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('TopologyNodeContent', () => {
  test('announces the map direction so the branch control can follow it', async () => {
    const { container } = await mount();
    expect(container.querySelector('.topology-node')?.getAttribute('data-flow')).toBe('LR');

    await act(async () => {
      root?.render(
        <TopologyNodeContent
          node={backboneOne}
          selected={false}
          flow="TB"
          onSelect={vi.fn()}
          onToggle={vi.fn()}
        />
      );
    });
    expect(container.querySelector('.topology-node')?.getAttribute('data-flow')).toBe('TB');
  });


  /**
   * O chip diz em que modo a unidade esta ligada. Sem modo registado nao ha chip:
   * um no por classificar nao ganha ruido — e o filtro que os junta para tratar.
   * Um modo escrito a mao aparece a letra e sem cor propria.
   */
  test('shows the WAN mode as a chip, and stays quiet without one', async () => {
    const { container } = await mount();
    const chip = container.querySelector('.topology-node-wan');
    expect(chip?.textContent).toBe('Estático');
    expect(chip?.getAttribute('data-wan')).toBe('static');

    const render = async (node: typeof backboneOne) => {
      await act(async () => {
        root?.render(
          <TopologyNodeContent node={node} selected={false} onSelect={vi.fn()} onToggle={vi.fn()} />
        );
      });
    };

    await render({ ...backboneOne, wanMode: 'IPv6 nativo' });
    expect(container.querySelector('.topology-node-wan')?.textContent).toBe('IPv6 nativo');
    expect(container.querySelector('.topology-node-wan')?.getAttribute('data-wan')).toBe('livre');

    // `backboneTwo` e o parque que a migracao 0056 deixou por classificar.
    await render(backboneTwo);
    expect(container.querySelector('.topology-node-wan')).toBeNull();
  });

  /**
   * Os dois eixos no mesmo cartao. Cada chip cala-se sozinho quando o seu campo
   * esta por classificar — sem isso, o dia em que a 0057 correr enchia o mapa de
   * chips vazios, porque o papel nasce todo nulo.
   */
  test('shows both mode chips, each silent on its own', async () => {
    const render = async (node: typeof backboneOne) => {
      await act(async () => {
        root?.render(
          <TopologyNodeContent node={node} selected={false} onSelect={vi.fn()} onToggle={vi.fn()} />
        );
      });
    };

    const { container } = await mount();
    // A fixture tem os dois: static + router.
    expect(container.querySelector('.topology-node-wan')?.textContent).toBe('Estático');
    expect(container.querySelector('.topology-node-op')?.textContent).toBe('Router');

    // So o papel: o chip de ligacao desaparece, o outro fica.
    await render({ ...backboneOne, wanMode: null, operationMode: 'ap' });
    expect(container.querySelector('.topology-node-wan')).toBeNull();
    expect(container.querySelector('.topology-node-op')?.textContent).toBe('AP');

    // So a ligacao.
    await render({ ...backboneOne, operationMode: null });
    expect(container.querySelector('.topology-node-wan')?.textContent).toBe('Estático');
    expect(container.querySelector('.topology-node-op')).toBeNull();

    // Papel escrito a mao: a letra, e sem cor propria (nao ha data-wan aqui).
    await render({ ...backboneOne, operationMode: 'WISP' });
    expect(container.querySelector('.topology-node-op')?.textContent).toBe('WISP');

    // Nenhum dos dois: nem sequer a caixa que os junta.
    await render({ ...backboneOne, wanMode: null, operationMode: null });
    expect(container.querySelector('.topology-node-modes')).toBeNull();
  });

  test('selects a focused node with Enter', async () => {
    const { container, onSelect } = await mount();
    const select = container.querySelector<HTMLButtonElement>('[data-topology-select]');
    if (!select) throw new Error('Node selection control not found');

    await act(async () => {
      select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledOnce();
  });

  test('gives expansion controls an explicit stateful accessible name', async () => {
    const collapsed = await mount();
    expect(collapsed.container.querySelector(
      '[aria-label="Expandir ramo Ubiquiti Rocket Prism"]'
    )).not.toBeNull();

    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();

    const expanded = await mount(true);
    expect(expanded.container.querySelector(
      '[aria-label="Recolher ramo Ubiquiti Rocket Prism"]'
    )).not.toBeNull();
  });

  test('marks the live probe reading, and leaves it unmarked when nobody measured', async () => {
    const { container } = await mount();
    // O fixture nunca foi sondado: sem leitura não há marca, porque ausência de
    // medição não é "de pé".
    expect(container.querySelector('.topology-node')?.hasAttribute('data-live')).toBe(false);

    await act(async () => {
      root?.render(
        <TopologyNodeContent
          node={{ ...backboneOne, liveState: 'down' }}
          selected={false}
          onSelect={vi.fn()}
          onToggle={vi.fn()}
        />
      );
    });
    expect(container.querySelector('.topology-node')?.getAttribute('data-live')).toBe('down');
  });

  test('prioritizes physical identity, location and CPE count in backbone metadata', async () => {
    const { container } = await mount(false, 3);

    expect(container.textContent).toContain('Rocket Prism');
    expect(container.textContent).toContain('10.20.0.1');
    expect(container.textContent).toContain('São Vicente · Monte Verde');
    expect(container.textContent).toContain('3 equipamentos');
    expect(container.textContent).not.toContain('inventário');
  });
});
