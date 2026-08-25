import { describe, expect, test } from 'vitest';
import { branchOne, branchTwo, snapshot } from './topologyTestFixtures';
import { filterTopologyGraph } from './topology-filters';
import { composeTopologyGraph } from './topology-graph';

const graph = composeTopologyGraph(
  snapshot,
  new Map([[10, branchOne], [20, branchTwo]]),
  new Set([10, 20])
);

describe('topology factual filters', () => {
  test('preserves root and backbone ancestors for a matching island and zone', () => {
    const filtered = filterTopologyGraph(graph, {
      island: 'sao vicente',
      zone: 'mindelo'
    });

    // O router do cliente entra com a antena dele: é o mesmo cliente, a mesma zona.
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual([
      'assignment:100',
      'assignment:101',
      'backbone:10',
      'root:isp'
    ]);
    expect(filtered.edges.map((edge) => edge.id).sort()).toEqual([
      'client-link:assignment:100:assignment:101',
      'client-link:backbone:10:assignment:100',
      'core-link:root:isp:backbone:10'
    ]);
  });

  test('filters by factual administrative state and attention', () => {
    const inactive = filterTopologyGraph(graph, { administrativeState: 'inactive' });
    const attention = filterTopologyGraph(graph, { attention: true });

    expect(inactive.nodes.map((node) => node.id).sort()).toEqual([
      'assignment:200',
      'backbone:20',
      'root:isp'
    ]);
    expect(attention.nodes.map((node) => node.id).sort()).toEqual([
      'assignment:200',
      'backbone:20',
      'root:isp'
    ]);
  });

  test('returns the composed graph unchanged when no factual filter is active', () => {
    expect(filterTopologyGraph(graph, {})).toEqual(graph);
  });
});
