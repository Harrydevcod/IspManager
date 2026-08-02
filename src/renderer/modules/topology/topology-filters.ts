import type {
  TopologyAdministrativeState,
  TopologyClientDeviceNode,
  TopologyNode
} from '../../../shared/topology';
import {
  collectAncestors,
  type TopologyFlowNode,
  type TopologyGraph
} from './topology-graph';

export type TopologyGraphFilters = {
  administrativeState?: TopologyAdministrativeState;
  attention?: boolean;
  island?: string;
  zone?: string;
};

function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function hasFilters(filters: TopologyGraphFilters): boolean {
  return filters.administrativeState !== undefined
    || filters.attention !== undefined
    || Boolean(normalize(filters.island))
    || Boolean(normalize(filters.zone));
}

function matchesLocation(
  node: TopologyClientDeviceNode,
  filters: TopologyGraphFilters
): boolean {
  const island = normalize(filters.island);
  const zone = normalize(filters.zone);
  return node.clients.some((client) => (
    (!island || normalize(client.island) === island)
    && (!zone || normalize(client.zone) === zone)
  ));
}

function matchesNode(node: TopologyNode, filters: TopologyGraphFilters): boolean {
  if (node.kind === 'logical-root') return false;
  if (
    filters.administrativeState
    && node.administrativeState !== filters.administrativeState
  ) return false;
  if (
    filters.attention !== undefined
    && (node.issueCodes.length > 0) !== filters.attention
  ) return false;
  if (!filters.island && !filters.zone) return true;
  return node.kind === 'client-device' && matchesLocation(node, filters);
}

export function filterTopologyGraph(
  graph: TopologyGraph,
  filters: TopologyGraphFilters
): TopologyGraph {
  if (!hasFilters(filters)) return graph;
  const matched = new Set(
    graph.nodes
      .filter((node: TopologyFlowNode) => matchesNode(node.data.topology, filters))
      .map((node) => node.id)
  );
  const visible = collectAncestors(graph, matched);
  return {
    nodes: graph.nodes.filter((node) => visible.has(node.id)),
    edges: graph.edges.filter((edge) => (
      visible.has(edge.source) && visible.has(edge.target)
    ))
  };
}
