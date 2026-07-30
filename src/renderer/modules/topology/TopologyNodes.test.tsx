/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { backboneOne } from './topologyTestFixtures';
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

  test('prioritizes physical identity, location and CPE count in backbone metadata', async () => {
    const { container } = await mount(false, 3);

    expect(container.textContent).toContain('Rocket Prism');
    expect(container.textContent).toContain('10.20.0.1');
    expect(container.textContent).toContain('São Vicente · Monte Verde');
    expect(container.textContent).toContain('3 CPE');
    expect(container.textContent).not.toContain('inventário');
  });
});
