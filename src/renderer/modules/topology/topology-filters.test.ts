import { describe, expect, test } from 'vitest';
import { branchOne, branchTwo, snapshot } from './topologyTestFixtures';
import { UNCLASSIFIED_WAN_MODE, filterTopologyGraph } from './topology-filters';
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

    // O router e o card do cliente entram com a antena: mesmo cliente, mesma zona.
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual([
      'assignment:100',
      'assignment:101',
      'backbone:10',
      'client:1@10',
      'root:isp'
    ]);
    expect(filtered.edges.map((edge) => edge.id).sort()).toEqual([
      'client-link:assignment:100:assignment:101',
      'client-link:backbone:10:assignment:100',
      'core-link:root:isp:backbone:10',
      'ownership:assignment:101:client:1@10'
    ]);
  });

  /**
   * A pergunta que este filtro responde e "quem ja esta em PPPoE e quem falta".
   * Os cards de cliente saem do mapa de proposito: `collectAncestors` so sobe, e
   * um cliente a corresponder arrastaria de volta o equipamento que o filtro
   * acabou de excluir.
   */
  test('filters by the registered WAN mode', () => {
    const staticMode = filterTopologyGraph(graph, { wanMode: 'static' });
    expect(staticMode.nodes.map((node) => node.id).sort()).toEqual([
      'backbone:10',
      'root:isp'
    ]);

    const pppoe = filterTopologyGraph(graph, { wanMode: 'pppoe' });
    expect(pppoe.nodes.map((node) => node.id).sort()).toEqual([
      'assignment:100',
      'assignment:101',
      'assignment:200',
      'backbone:10',
      'backbone:20',
      'root:isp'
    ]);
  });

  /** O parque que a 0056 deixou nulo — a lista de trabalho de quem classifica. */
  test('gathers the unclassified equipment', () => {
    const filtered = filterTopologyGraph(graph, { wanMode: UNCLASSIFIED_WAN_MODE });
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual([
      'backbone:20',
      'root:isp'
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
