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

  /*
   * O mapa é controlado e não tem `onNodesChange`, por isso as medições que o
   * React Flow faz nunca voltam para os nós. Sem `measured`, o `fitView` ignora
   * o nó e o mapa abre por enquadrar — é daqui que as medidas têm de vir.
   */
  test('carries the rendered size of every node so the canvas can frame them', () => {
    const laidOut = layoutTopologyGraph(graph);

    expect(laidOut.nodes.length).toBeGreaterThan(2);
    for (const node of laidOut.nodes) {
      expect(node.measured).toEqual({ width: node.width, height: node.height });
      expect(node.measured?.width).toBeGreaterThan(0);
      expect(node.measured?.height).toBeGreaterThan(0);
    }
  });

  test('stacks the same graph downwards when the map is turned vertical', () => {
    const laidOut = layoutTopologyGraph(graph, 'TB');
    const byId = new Map(laidOut.nodes.map((node) => [node.id, node]));
    const root = byId.get('root:isp')!;
    const backbone = byId.get('backbone:10')!;
    const secondBackbone = byId.get('backbone:20')!;
    const client = byId.get('assignment:100')!;

    expect(root.position.y).toBeLessThan(backbone.position.y);
    expect(secondBackbone.position.y).toBe(backbone.position.y);
    expect(secondBackbone.position.x).not.toBe(backbone.position.x);
    expect(backbone.position.y).toBeLessThan(client.position.y);
    expect(root.sourcePosition).toBe('bottom');
    expect(client.targetPosition).toBe('top');
  });

  test('produces identical positions regardless of input ordering', () => {
    const reversed = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse()
    };
    for (const direction of ['LR', 'TB'] as const) {
      expect(positions(layoutTopologyGraph(reversed, direction))).toEqual(
        positions(layoutTopologyGraph(graph, direction))
      );
    }
  });
});
