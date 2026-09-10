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
  /**
   * Modo de ligação do equipamento. `UNCLASSIFIED_WAN_MODE` junta o parque que
   * ainda não foi classificado — é a lista de trabalho de quem está a migrar.
   */
  wanMode?: string;
};

/** Valor especial: equipamento sem modo registado (nulo na base de dados). */
export const UNCLASSIFIED_WAN_MODE = '__sem_modo__';

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
    || Boolean(normalize(filters.zone))
    || Boolean(filters.wanMode);
}

/**
 * Só o equipamento tem modo de ligação — cliente e raiz não têm.
 *
 * Com este filtro ligado, um card de cliente nunca corresponde: `collectAncestors`
 * só sobe, portanto um cliente a corresponder arrastaria de volta o equipamento
 * que o filtro acabou de excluir. O mapa filtrado mostra o equipamento, que é
 * exactamente o que responde a "quem já está em PPPoE e quem falta".
 */
function matchesWanMode(node: TopologyNode, wanMode: string): boolean {
  if (node.kind !== 'backbone' && node.kind !== 'client-device') return false;
  const current = normalize(node.wanMode);
  if (wanMode === UNCLASSIFIED_WAN_MODE) return !current;
  return current === normalize(wanMode);
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
  if (filters.wanMode && !matchesWanMode(node, filters.wanMode)) return false;
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
