/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  backboneOne,
  backboneTwo,
  branchOne,
  deviceOne,
  snapshot
} from './topologyTestFixtures';
import { TopologyInspector } from './TopologyInspector';

let root: Root | null = null;

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test('shows factual CPE associations and routes destination actions', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const onOpenClient = vi.fn();
  const onOpenService = vi.fn();
  const onOpenStock = vi.fn();

  await act(async () => {
    root?.render(
      <TopologyInspector
        node={deviceOne}
        snapshot={snapshot}
        branch={branchOne}
        onClose={() => undefined}
        onOpenClient={onOpenClient}
        onOpenService={onOpenService}
        onOpenStock={onOpenStock}
      />
    );
  });

  expect(container.textContent).toContain('SN-100');
  expect(container.textContent).toContain('Cliente 1');
  expect(container.textContent).toContain('Pro');
  expect(container.textContent).toContain('não representa reachability');

  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!button) throw new Error(`Button not found: ${label}`);
    await act(async () => button.click());
  };
  await click('Abrir cliente');
  await click('Abrir serviço');
  await click('Abrir no Stock');

  expect(onOpenClient).toHaveBeenCalledWith(1);
  expect(onOpenService).toHaveBeenCalledWith(1, 10);
  expect(onOpenStock).toHaveBeenCalledWith(10);
});

test('shows the physical backbone identity and preserves Stock navigation', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const onOpenStock = vi.fn();

  await act(async () => {
    root?.render(
      <TopologyInspector
        node={backboneOne}
        snapshot={snapshot}
        branch={branchOne}
        onClose={() => undefined}
        onOpenClient={() => undefined}
        onOpenService={() => undefined}
        onOpenStock={onOpenStock}
      />
    );
  });

  expect(container.textContent).toContain('BB-010');
  expect(container.textContent).toContain('AT-010');
  expect(container.textContent).toContain('10.20.0.1');
  expect(container.textContent).toContain('AA:BB:CC:DD:EE:10');
  expect(container.textContent).toContain('São Vicente · Monte Verde');
  expect(container.textContent).toContain('CPE no ramo1');

  const openStock = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === 'Abrir no Stock');
  if (!openStock) throw new Error('Stock navigation not found');
  await act(async () => openStock.click());
  expect(onOpenStock).toHaveBeenCalledWith(10);
});

test('surfaces provisional physical backbone identity as attention', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <TopologyInspector
        node={backboneTwo}
        snapshot={snapshot}
        onClose={() => undefined}
        onOpenClient={() => undefined}
        onOpenService={() => undefined}
        onOpenStock={() => undefined}
      />
    );
  });

  expect(container.textContent).toContain('Identidade provisória');
  expect(container.textContent).toContain('SerialNão indicado');
  expect(container.textContent).toContain('IP configuradoEm falta');
  expect(container.textContent).toContain('LocalizaçãoNão indicada');
});

test('distinguishes linked CPE from assignments without a defined link', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const snapshotWithGap = {
    ...snapshot,
    stats: {
      ...snapshot.stats,
      assignmentCount: 3,
      mappedAssignmentCount: 1,
      unmappedAssignmentCount: 2
    }
  };

  await act(async () => {
    root?.render(
      <TopologyInspector
        node={snapshotWithGap.root}
        snapshot={snapshotWithGap}
        onClose={() => undefined}
        onOpenClient={() => undefined}
        onOpenService={() => undefined}
        onOpenStock={() => undefined}
      />
    );
  });

  expect(container.textContent).toContain('CPE físicas3');
  expect(container.textContent).toContain('Com ligação1');
  expect(container.textContent).toContain('Sem ligação2');
});

test('marks a searched CPE that has no defined backbone link', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const unmappedDevice = {
    ...deviceOne,
    parentId: 'root:isp' as const,
    relationship: undefined
  };

  await act(async () => {
    root?.render(
      <TopologyInspector
        node={unmappedDevice}
        snapshot={snapshot}
        onClose={() => undefined}
        onOpenClient={() => undefined}
        onOpenService={() => undefined}
        onOpenStock={() => undefined}
      />
    );
  });

  expect(container.textContent).toContain('Sem ligação definida');
});
