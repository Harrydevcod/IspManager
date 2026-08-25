import type { Edge, Node } from '@xyflow/react';
import type {
  TopologyBackboneBranch,
  TopologyEdge,
  TopologyNode,
  TopologyRelationship,
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

const RELATIONSHIP_LABELS: Record<TopologyRelationship, 'ligação definida'> = {
  defined_link: 'ligação definida'
};

export function topologyRelationshipLabel(
  relationship: TopologyRelationship
): 'ligação definida' {
  return RELATIONSHIP_LABELS[relationship];
}

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
  branch.clientNodes.forEach((node) => nodes.set(node.id, toFlowNode(node)));
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

function relatives(
  graph: TopologyGraph,
  seeds: Iterable<string>,
  direction: 'up' | 'down'
): Set<string> {
  const next = new Map<string, string[]>();
  graph.edges.forEach((edge) => {
    const [from, to] = direction === 'up'
      ? [edge.target, edge.source]
      : [edge.source, edge.target];
    next.set(from, [...(next.get(from) ?? []), to]);
  });
  const found = new Set(seeds);
  const pending = [...found];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const neighbour of next.get(current) ?? []) {
      if (found.has(neighbour)) continue;
      found.add(neighbour);
      pending.push(neighbour);
    }
  }
  return found;
}

/** Sobe até à raiz a partir dos nós dados: um filho visível arrasta os pais. */
export function collectAncestors(
  graph: TopologyGraph,
  matched: Set<string>
): Set<string> {
  return relatives(graph, matched, 'up');
}

/**
 * A rede inteira não cabe num ecrã — ~8000px de largura com os ramos todos
 * abertos, para um `minZoom` de 0.25. Recortada por antena cabe: o backbone
 * escolhido, tudo o que pende dele e a cadeia acima, para não se perder de onde
 * vem a Internet. Um id que não exista no grafo devolve o grafo intacto.
 */
export function scopeGraphToBackbone(
  graph: TopologyGraph,
  backboneNodeId: string
): TopologyGraph {
  if (!graph.nodes.some((node) => node.id === backboneNodeId)) return graph;
  const visible = new Set([
    ...relatives(graph, [backboneNodeId], 'down'),
    ...relatives(graph, [backboneNodeId], 'up')
  ]);
  return {
    nodes: graph.nodes.filter((node) => visible.has(node.id)),
    edges: graph.edges.filter((edge) => (
      visible.has(edge.source) && visible.has(edge.target)
    ))
  };
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
