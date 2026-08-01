/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TopologySearchResult } from '../../../shared/topology';
import { Button } from '../../components';
import type { TopologyApi } from './topology-api';
import { backboneOne, branchOne, snapshot } from './topologyTestFixtures';
import { useTopologyWorkspace } from './useTopologyWorkspace';

let root: Root | null = null;

const physicalBackbone = {
  ...backboneOne,
  id: 'backbone:77' as const,
  backboneDeviceId: 77,
  catalogId: 10,
  label: 'Backbone físico Fogo'
};

const searchResult: TopologySearchResult = {
  node: physicalBackbone,
  matchedFields: ['backbone'],
  ancestors: [{
    id: 'root:isp',
    kind: 'logical-root',
    label: 'Internet'
  }]
};

function Harness({ api }: { api: TopologyApi }) {
  const workspace = useTopologyWorkspace(api);
  const branch = workspace.branches.get(77);
  return (
    <section>
      <Button onClick={() => void workspace.selectSearchResult(searchResult)}>
        Selecionar resultado
      </Button>
      <Button onClick={() => void workspace.refresh()}>Atualizar</Button>
      <output>{workspace.selectedNode?.label ?? 'Sem seleção'}</output>
      <output data-testid="branch-cpe">
        {branch?.nodes.map((node) => node.label).join(' · ') ?? 'Ramo fechado'}
      </output>
    </section>
  );
}

function click(container: HTMLElement, label: string) {
  [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label)
    ?.click();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('loads a searched backbone branch by physical device id instead of catalog id', async () => {
  const fetchBranch = vi.fn(async () => ({
    ...branchOne,
    backbone: physicalBackbone
  }));
  const api: TopologyApi = {
    fetchSnapshot: vi.fn(async () => ({
      ...snapshot,
      backbones: [physicalBackbone]
    })),
    fetchBranch,
    search: vi.fn()
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(<Harness api={api} />);
    await Promise.resolve();
  });
  await act(async () => {
    click(container, 'Selecionar resultado');
    await Promise.resolve();
  });

  expect(fetchBranch).toHaveBeenCalledWith(77);
  expect(container.textContent).toContain('Backbone físico Fogo');
});

test('refresh brings a newly linked CPE into an already open branch', async () => {
  // O ramo é lido uma vez sem a CPE nova; depois de a ligar noutro sítio, é o
  // refresh que a tem de trazer — sem fechar o ramo que o operador tem aberto.
  const newcomer = {
    ...branchOne.nodes[0],
    id: 'assignment:99' as const,
    assignmentId: 99,
    label: 'CPE do Cay Luiz'
  };
  const fetchBranch = vi.fn()
    .mockResolvedValueOnce({ ...branchOne, backbone: physicalBackbone, nodes: [] })
    .mockResolvedValue({ ...branchOne, backbone: physicalBackbone, nodes: [newcomer] });
  const api: TopologyApi = {
    fetchSnapshot: vi.fn(async () => ({ ...snapshot, backbones: [physicalBackbone] })),
    fetchBranch,
    search: vi.fn()
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(<Harness api={api} />);
    await Promise.resolve();
  });
  await act(async () => {
    click(container, 'Selecionar resultado');
    await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="branch-cpe"]')?.textContent).toBe('');

  await act(async () => {
    click(container, 'Atualizar');
    await Promise.resolve();
  });

  expect(fetchBranch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-testid="branch-cpe"]')?.textContent)
    .toBe('CPE do Cay Luiz');
});
