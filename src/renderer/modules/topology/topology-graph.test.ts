import { describe, expect, test } from 'vitest';
import { branchOne, branchTwo, snapshot } from './topologyTestFixtures';
import {
  composeTopologyGraph,
  scopeGraphToBackbone,
  topologyRelationshipLabel,
  toggleBackboneExpansion
} from './topology-graph';

describe('topology graph composition', () => {
  test('labels every persisted relationship as a defined link', () => {
    expect(topologyRelationshipLabel('defined_link')).toBe('ligação definida');
  });

  test('expands and collapses without mutating expansion state', () => {
    const original = new Set<number>();
    const expanded = toggleBackboneExpansion(original, 10);
    const collapsed = toggleBackboneExpansion(expanded, 10);

    expect(original).toEqual(new Set());
    expect(expanded).toEqual(new Set([10]));
    expect(collapsed).toEqual(new Set());
  });

  test('renders branch nodes and edges only while their backbone is expanded', () => {
    const branches = new Map([[10, branchOne]]);
    const collapsed = composeTopologyGraph(snapshot, branches, new Set());
    const expanded = composeTopologyGraph(snapshot, branches, new Set([10]));

    expect(collapsed.nodes.map((node) => node.id)).toEqual([
      'root:isp',
      'backbone:10',
      'backbone:20'
    ]);
    expect(collapsed.edges).toHaveLength(2);
    expect(expanded.nodes.map((node) => node.id)).toContain('assignment:100');
    expect(expanded.edges.map((edge) => edge.id))
      .toContain('client-link:backbone:10:assignment:100');
  });

  /*
   * A rede inteira não cabe legível num ecrã (~8000px com os ramos abertos,
   * `minZoom` 0.25). Recortar por antena é o que a torna consultável.
   */
  test('scopes the map to one backbone, keeping its branch and the chain above', () => {
    const graph = composeTopologyGraph(
      snapshot,
      new Map([[10, branchOne], [20, branchTwo]]),
      new Set([10, 20])
    );

    const scoped = scopeGraphToBackbone(graph, 'backbone:10');
    const ids = scoped.nodes.map((node) => node.id);

    expect(ids).toContain('backbone:10');
    expect(ids).toContain('assignment:100');
    expect(ids).toContain('root:isp');
    // O irmão e o ramo dele ficam fora da vista.
    expect(ids).not.toContain('backbone:20');
    expect(ids).not.toContain('assignment:200');
    expect(scoped.edges.every((edge) => (
      ids.includes(edge.source) && ids.includes(edge.target)
    ))).toBe(true);
  });

  test('leaves the graph untouched when the scoped backbone is not on the map', () => {
    const graph = composeTopologyGraph(snapshot, new Map(), new Set());

    expect(scopeGraphToBackbone(graph, 'backbone:999')).toBe(graph);
  });

  test('merges multiple loaded branches with stable physical-node deduplication', () => {
    const duplicate = {
      ...branchTwo,
      nodes: [branchTwo.nodes[0], branchOne.nodes[0]],
      edges: [...branchTwo.edges, branchOne.edges[0]]
    };
    const graph = composeTopologyGraph(
      snapshot,
      new Map([[10, branchOne], [20, duplicate]]),
      new Set([10, 20])
    );

    expect(graph.nodes.filter((node) => node.id === 'assignment:100')).toHaveLength(1);
    // Raiz, dois backbones, a antena e o router do cliente, e a antena do ramo 2.
    expect(graph.nodes).toHaveLength(6);
    expect(graph.edges.filter((edge) => (
      edge.id === 'client-link:backbone:10:assignment:100'
    ))).toHaveLength(1);
  });

  test('uses the loaded branch backbone as the freshest node representation', () => {
    const refreshed = {
      ...branchOne,
      backbone: { ...branchOne.backbone, label: 'Refreshed backbone' }
    };
    const graph = composeTopologyGraph(
      snapshot,
      new Map([[10, refreshed]]),
      new Set([10])
    );

    expect(graph.nodes.find((node) => node.id === 'backbone:10')?.data.topology)
      .toMatchObject({ label: 'Refreshed backbone' });
  });
});
