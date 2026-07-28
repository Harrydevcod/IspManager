import type { Edge, Node } from '@xyflow/react';
import type {
  TopologyBackboneBranch,
  TopologyEdge,
  TopologyNode,
  TopologySnapshot
} from '../../../shared/topology';

export type TopologyFlowNodeData = {
  topology: TopologyNode;
} & Record<string, unknown>;

export type TopologyFlowEdgeData = {
  topology: TopologyEdge;
} & Record<string, unknown>;

export type TopologyFlowNode = Node<
  TopologyFlowNodeData,
  TopologyNode['kind']
>;

export type TopologyFlowEdge = Edge<TopologyFlowEdgeData>;

export type TopologyGraph = {
  nodes: TopologyFlowNode[];
  edges: TopologyFlowEdge[];
};

function toFlowNode(node: TopologyNode): TopologyFlowNode {
  return {
    id: node.id,
    type: node.kind,
    position: { x: 0, y: 0 },
    data: { topology: node }
  };
}

function toFlowEdge(edge: TopologyEdge): TopologyFlowEdge {
  return {
    id: edge.id,
    type: edge.kind,
    source: edge.source,
    target: edge.target,
    data: { topology: edge }
  };
}

function mergeBranch(
  branch: TopologyBackboneBranch,
  nodes: Map<string, TopologyFlowNode>,
  edges: Map<string, TopologyFlowEdge>
): void {
  nodes.set(branch.backbone.id, toFlowNode(branch.backbone));
  branch.nodes.forEach((node) => nodes.set(node.id, toFlowNode(node)));
  branch.edges.forEach((edge) => edges.set(edge.id, toFlowEdge(edge)));
}

export function composeTopologyGraph(
  snapshot: TopologySnapshot,
  branches: ReadonlyMap<number, TopologyBackboneBranch>,
  expanded: ReadonlySet<number>
): TopologyGraph {
  const initialNodes = [snapshot.root, ...snapshot.backbones].map(toFlowNode);
  const nodes = new Map(initialNodes.map((node) => [node.id, node]));
  const initialEdges = snapshot.edges.map(toFlowEdge);
  const edges = new Map(initialEdges.map((edge) => [edge.id, edge]));

  [...expanded].sort((left, right) => left - right).forEach((catalogId) => {
    const branch = branches.get(catalogId);
    if (branch) mergeBranch(branch, nodes, edges);
  });
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function toggleBackboneExpansion(
  expanded: ReadonlySet<number>,
  catalogId: number
): Set<number> {
  const next = new Set(expanded);
  if (next.has(catalogId)) next.delete(catalogId);
  else next.add(catalogId);
  return next;
}
