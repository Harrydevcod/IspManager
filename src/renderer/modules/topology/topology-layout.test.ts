import { describe, expect, test } from 'vitest';
import { branchOne, snapshot } from './topologyTestFixtures';
import { composeTopologyGraph } from './topology-graph';
import { layoutTopologyGraph } from './topology-layout';

const graph = composeTopologyGraph(
  snapshot,
  new Map([[10, branchOne]]),
  new Set([10])
);

function positions(result: ReturnType<typeof layoutTopologyGraph>) {
  return Object.fromEntries(result.nodes.map((node) => [node.id, node.position]));
}

describe('topology Dagre layout', () => {
  test('places root, backbones and client devices in deterministic left-to-right columns', () => {
    const laidOut = layoutTopologyGraph(graph);
    const byId = new Map(laidOut.nodes.map((node) => [node.id, node]));
    const root = byId.get('root:isp')!;
    const backbone = byId.get('backbone:10')!;
    const secondBackbone = byId.get('backbone:20')!;
    const client = byId.get('assignment:100')!;

    expect(root.position.x).toBeLessThan(backbone.position.x);
    expect(secondBackbone.position.x).toBe(backbone.position.x);
    expect(secondBackbone.position.y).not.toBe(backbone.position.y);
    expect(backbone.position.x).toBeLessThan(client.position.x);
    expect(root.sourcePosition).toBe('right');
    expect(client.targetPosition).toBe('left');
  });

  test('produces identical positions regardless of input ordering', () => {
    const reversed = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse()
    };
    expect(positions(layoutTopologyGraph(reversed))).toEqual(
      positions(layoutTopologyGraph(graph))
    );
  });
});
