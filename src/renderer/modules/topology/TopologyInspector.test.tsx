/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { branchOne, deviceOne, snapshot } from './topologyTestFixtures';
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

test('distinguishes mapped CPE from assignments without backbone lineage', async () => {
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
  expect(container.textContent).toContain('Com linhagem1');
  expect(container.textContent).toContain('Sem linhagem2');
});

test('marks a searched CPE that has no factual backbone lineage', async () => {
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

  expect(container.textContent).toContain('Sem linhagem de backbone');
});
