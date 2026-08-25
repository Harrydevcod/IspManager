import type {
  TopologyAdministrativeState,
  TopologyClientDeviceNode,
  TopologyClientNode,
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

function matchesPlace(
  place: { island: string | null; zone: string | null },
  filters: TopologyGraphFilters
): boolean {
  const island = normalize(filters.island);
  const zone = normalize(filters.zone);
  return (!island || normalize(place.island) === island)
    && (!zone || normalize(place.zone) === zone);
}

function matchesLocation(
  node: TopologyClientDeviceNode,
  filters: TopologyGraphFilters
): boolean {
  return node.clients.some((client) => matchesPlace(client, filters));
}

function matchesClientLocation(
  node: TopologyClientNode,
  filters: TopologyGraphFilters
): boolean {
  return matchesPlace(node, filters);
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
  /*
   * O card de cliente tem de responder por si: `collectAncestors` só sobe, por
   * isso um filho que não corresponda desaparece mesmo que o pai fique.
   */
  if (node.kind === 'client') return matchesClientLocation(node, filters);
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
