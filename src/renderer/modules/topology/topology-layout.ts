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

/** `LR` corre para a direita; `TB` desce e espalha os irmãos pela largura. */
export type TopologyDirection = 'LR' | 'TB';

const ANCHORS: Record<TopologyDirection, { source: Position; target: Position }> = {
  LR: { source: Position.Right, target: Position.Left },
  TB: { source: Position.Bottom, target: Position.Top }
};

const SIZES: Record<TopologyFlowNode['type'], NodeSize> = {
  'logical-root': { width: 180, height: 72 },
  backbone: { width: 240, height: 104 },
  'client-device': { width: 260, height: 128 },
  // Fecha a cadeia sem competir com o equipamento: mais baixo, sem estado nem
  // controlo de ramo para desenhar.
  client: { width: 240, height: 88 }
};

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function createLayoutGraph(graph: TopologyGraph, direction: TopologyDirection): Graph {
  const dagre = new Graph({ multigraph: true })
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({
      rankdir: direction,
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

function positionNode(
  node: TopologyFlowNode,
  dagre: Graph,
  direction: TopologyDirection
): TopologyFlowNode {
  const coordinates = dagre.node(node.id);
  const size = SIZES[node.type];
  return {
    ...node,
    width: size.width,
    height: size.height,
    /*
     * O React Flow só escreve `measured` ao aplicar uma alteração `dimensions`
     * vinda do `onNodesChange` — e este mapa é controlado, sem esse handler, por
     * isso as medições dele nunca voltavam para cá. Sem `measured`, o `fitView`
     * ignora o nó (`getFitViewNodes`) e o mapa abria por enquadrar. As medidas
     * são estas: o CSS dos nós usa exatamente os valores de `SIZES`.
     */
    measured: { width: size.width, height: size.height },
    position: {
      x: coordinates.x - size.width / 2,
      y: coordinates.y - size.height / 2
    },
    sourcePosition: ANCHORS[direction].source,
    targetPosition: ANCHORS[direction].target
  };
}

export function layoutTopologyGraph(
  graph: TopologyGraph,
  direction: TopologyDirection = 'LR'
): TopologyGraph {
  const dagre = createLayoutGraph(graph, direction);
  return {
    nodes: [...graph.nodes]
      .sort(compareById)
      .map((node) => positionNode(node, dagre, direction)),
    edges: [...graph.edges].sort(compareById)
  };
}
