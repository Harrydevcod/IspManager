import { Graph, layout } from '@dagrejs/dagre';
import { Position } from '@xyflow/react';
import type {
  TopologyFlowNode,
  TopologyGraph
} from './topology-graph';

type NodeSize = {
  width: number;
  height: number;
};

const SIZES: Record<TopologyFlowNode['type'], NodeSize> = {
  'logical-root': { width: 180, height: 72 },
  backbone: { width: 240, height: 104 },
  'client-device': { width: 260, height: 128 }
};

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function createLayoutGraph(graph: TopologyGraph): Graph {
  const dagre = new Graph({ multigraph: true })
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({
      rankdir: 'LR',
      ranker: 'network-simplex',
      nodesep: 48,
      ranksep: 96,
      marginx: 0,
      marginy: 0
    });
  [...graph.nodes].sort(compareById).forEach((node) => {
    dagre.setNode(node.id, { ...SIZES[node.type] });
  });
  [...graph.edges].sort(compareById).forEach((edge) => {
    dagre.setEdge(edge.source, edge.target, {}, edge.id);
  });
  layout(dagre);
  return dagre;
}

function positionNode(node: TopologyFlowNode, dagre: Graph): TopologyFlowNode {
  const coordinates = dagre.node(node.id);
  const size = SIZES[node.type];
  return {
    ...node,
    width: size.width,
    height: size.height,
    position: {
      x: coordinates.x - size.width / 2,
      y: coordinates.y - size.height / 2
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left
  };
}

export function layoutTopologyGraph(graph: TopologyGraph): TopologyGraph {
  const dagre = createLayoutGraph(graph);
  return {
    nodes: [...graph.nodes].sort(compareById).map((node) => positionNode(node, dagre)),
    edges: [...graph.edges].sort(compareById)
  };
}
