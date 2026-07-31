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
  return (
    <section>
      <Button onClick={() => void workspace.selectSearchResult(searchResult)}>
        Selecionar resultado
      </Button>
      <output>{workspace.selectedNode?.label ?? 'Sem seleção'}</output>
    </section>
  );
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
    [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Selecionar resultado')
      ?.click();
    await Promise.resolve();
  });

  expect(fetchBranch).toHaveBeenCalledWith(77);
  expect(container.textContent).toContain('Backbone físico Fogo');
});
