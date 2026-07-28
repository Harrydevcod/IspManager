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
  const catalog = [
    { name: 'backbone', value: node.label },
    { name: 'backbone', value: node.brand },
    { name: 'backbone', value: node.model },
    { name: 'backbone', value: node.catalogType }
  ];
  if (node.kind === 'backbone') return catalog;
  return [
    ...catalog,
    { name: 'ip', value: node.ipAddress },
    { name: 'mac', value: node.macAddress },
    { name: 'serial', value: node.serialNumber },
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
  if (node.kind === 'backbone') return { islands: [], zones: [] };
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

function ancestors(
  node: TopologyBackboneNode | TopologyClientDeviceNode,
  backbones: Map<number, TopologyBackboneNode>
): TopologyAncestor[] {
  const result: TopologyAncestor[] = [{
    id: 'root:isp',
    kind: 'logical-root',
    label: 'Internet / Core ISPM'
  }];
  if (node.kind === 'backbone') return result;
  const backbone = backbones.get(node.catalogId);
  if (backbone) {
    result.push({
      id: backbone.id,
      kind: 'backbone',
      label: backbone.label,
      relationship: 'inventory_lineage'
    });
  }
  return result;
}

function resultFor(
  node: TopologyBackboneNode | TopologyClientDeviceNode,
  matches: string[],
  backbones: Map<number, TopologyBackboneNode>
): TopologySearchResult {
  return {
    node,
    matchedFields: matches,
    ancestors: ancestors(node, backbones)
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
  const backbones = new Map(snapshot.backbones.map((item) => [item.catalogId, item]));
  const nodes = [...snapshot.backbones, ...snapshot.clientDevices];
  const results = nodes.flatMap((node) => {
    const matches = matchedFields(node, query);
    return matches.length > 0 && passesFilters(node, filters)
      ? [resultFor(node, matches, backbones)]
      : [];
  }).slice(0, options.limit);
  return { generatedAt: now.toISOString(), query, filters, results };
}
