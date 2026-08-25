import type Database from 'better-sqlite3';
import type {
  TopologyAncestor,
  TopologyBackboneNode,
  TopologyClientDeviceNode,
  TopologySearchFilters,
  TopologySearchResponse,
  TopologySearchResult
} from '../../shared/topology';
import { loadSearchableTopologyNodes } from './topology-read-model';

type SearchOptions = TopologySearchFilters & {
  query: string;
  limit: number;
};

type SearchField = {
  name: string;
  value: string | null | undefined;
};

export function normalizeTopologyText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt');
}

function clientFields(node: TopologyClientDeviceNode): SearchField[] {
  return node.clients.flatMap((client) => [
    { name: 'clientName', value: client.fullName },
    { name: 'clientCode', value: client.clientCode },
    { name: 'island', value: client.island },
    { name: 'zone', value: client.zone }
  ]);
}

function nodeFields(node: TopologyBackboneNode | TopologyClientDeviceNode): SearchField[] {
  const equipment = [
    { name: 'backbone', value: node.label },
    { name: 'backbone', value: node.brand },
    { name: 'backbone', value: node.model },
    { name: 'backbone', value: node.catalogType }
  ];
  const identity = [
    { name: 'ip', value: node.ipAddress },
    { name: 'mac', value: node.macAddress },
    { name: 'serial', value: node.serialNumber },
    { name: 'assetTag', value: node.assetTag }
  ];
  if (node.kind === 'backbone') {
    return [
      ...equipment,
      ...identity,
      { name: 'island', value: node.island },
      { name: 'zone', value: node.zone }
    ];
  }
  return [
    ...equipment,
    ...identity,
    ...clientFields(node)
  ];
}

function matchedFields(
  node: TopologyBackboneNode | TopologyClientDeviceNode,
  query: string
): string[] {
  return [...new Set(
    nodeFields(node)
      .filter((field) => normalizeTopologyText(field.value ?? '').includes(query))
      .map((field) => field.name)
  )];
}

function nodeLocations(node: TopologyBackboneNode | TopologyClientDeviceNode): {
  islands: string[];
  zones: string[];
} {
  if (node.kind === 'backbone') {
    return {
      islands: [normalizeTopologyText(node.island ?? '')],
      zones: [normalizeTopologyText(node.zone ?? '')]
    };
  }
  return {
    islands: node.clients.map((client) => normalizeTopologyText(client.island ?? '')),
    zones: node.clients.map((client) => normalizeTopologyText(client.zone ?? ''))
  };
}

function passesFilters(
  node: TopologyBackboneNode | TopologyClientDeviceNode,
  filters: TopologySearchFilters
): boolean {
  if (filters.administrativeState && node.administrativeState !== filters.administrativeState) {
    return false;
  }
  if (filters.attention !== undefined && (node.issueCodes.length > 0) !== filters.attention) {
    return false;
  }
  const locations = nodeLocations(node);
  if (filters.island && !locations.islands.includes(normalizeTopologyText(filters.island))) {
    return false;
  }
  if (filters.zone && !locations.zones.includes(normalizeTopologyText(filters.zone))) {
    return false;
  }
  return true;
}

/** A primeira alimentação declarada, ou a raiz quando não há nenhuma. */
function firstParentId(
  node: TopologyBackboneNode | TopologyClientDeviceNode
): 'root:isp' | `backbone:${number}` | `assignment:${number}` {
  return node.kind === 'backbone' ? node.parentIds[0] ?? 'root:isp' : node.parentId;
}

function ancestorOf(
  node: TopologyBackboneNode | TopologyClientDeviceNode
): TopologyAncestor {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    relationship: 'defined_link'
  };
}

/**
 * Caminho ordenado da raiz até ao pai imediato. Com a cadeia física explícita,
 * um CPE pode estar a vários saltos da Internet (Starlink → router → AP → CPE),
 * e o router do cliente pende do CPE, um salto mais abaixo ainda.
 *
 * Onde há agregação multi-WAN existe mais do que um caminho até à Internet:
 * seguimos o primeiro (a lista vem ordenada por nome, logo é estável). O painel
 * serve para situar o nó na rede, não para provar por onde o tráfego passa. O
 * conjunto de visitados trava dados que já estejam em ciclo.
 */
function ancestors(
  node: TopologyBackboneNode | TopologyClientDeviceNode,
  backbones: Map<number, TopologyBackboneNode>,
  clientDevices: Map<number, TopologyClientDeviceNode>
): TopologyAncestor[] {
  const chain: TopologyAncestor[] = [];
  const visited = new Set<string>();
  let parentId = firstParentId(node);
  while (parentId !== 'root:isp' && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = parentId.startsWith('assignment:')
      ? clientDevices.get(Number(parentId.slice('assignment:'.length)))
      : backbones.get(Number(parentId.slice('backbone:'.length)));
    if (!parent) break;
    chain.unshift(ancestorOf(parent));
    parentId = firstParentId(parent);
  }
  return [{ id: 'root:isp', kind: 'logical-root', label: 'Internet' }, ...chain];
}

function resultFor(
  node: TopologyBackboneNode | TopologyClientDeviceNode,
  matches: string[],
  backbones: Map<number, TopologyBackboneNode>,
  clientDevices: Map<number, TopologyClientDeviceNode>
): TopologySearchResult {
  return {
    node,
    matchedFields: matches,
    ancestors: ancestors(node, backbones, clientDevices)
  };
}

export function searchTopology(
  db: Database.Database,
  options: SearchOptions,
  now = new Date()
): TopologySearchResponse {
  const snapshot = loadSearchableTopologyNodes(db);
  const query = normalizeTopologyText(options.query);
  const filters: TopologySearchFilters = {
    administrativeState: options.administrativeState,
    attention: options.attention,
    island: options.island,
    zone: options.zone
  };
  const backbones = new Map(snapshot.backbones.map((item) => [item.backboneDeviceId, item]));
  const clientDevices = new Map(snapshot.clientDevices.map((item) => [item.assignmentId, item]));
  const nodes = [...snapshot.backbones, ...snapshot.clientDevices];
  const results = nodes.flatMap((node) => {
    const matches = matchedFields(node, query);
    return matches.length > 0 && passesFilters(node, filters)
      ? [resultFor(node, matches, backbones, clientDevices)]
      : [];
  }).slice(0, options.limit);
  return { generatedAt: now.toISOString(), query, filters, results };
}
