export type TopologyIssueCode =
  | 'inactive'
  | 'missing_ip'
  | 'suspended_service'
  | 'incomplete_configuration'
  | 'provisional_identity';

export type TopologyAdministrativeState = 'active' | 'inactive';
export type TopologyRelationship = 'defined_link';
export type TopologyNodeId = 'root:isp' | `backbone:${number}` | `assignment:${number}`;

export type TopologyServiceAssociation = {
  id: number;
  status: 'active' | 'suspended' | 'cancelled';
  planId: number | null;
  planName: string | null;
  assignmentIds: number[];
};

export type TopologyClientAssociation = {
  id: number;
  clientCode: string;
  fullName: string;
  status: 'active' | 'suspended' | 'cancelled';
  island: string | null;
  zone: string | null;
  services: TopologyServiceAssociation[];
};

export type TopologyLogicalRootNode = {
  id: 'root:isp';
  kind: 'logical-root';
  label: 'Internet';
  administrativeState: 'active';
  issueCodes: [];
};

export type TopologyBackboneNode = {
  id: `backbone:${number}`;
  kind: 'backbone';
  backboneDeviceId: number;
  catalogId: number;
  label: string;
  brand: string | null;
  model: string;
  catalogType: string;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  island: string | null;
  zone: string | null;
  provisional: boolean;
  administrativeState: TopologyAdministrativeState;
  issueCodes: TopologyIssueCode[];
  /** Última leitura da sonda ICMP. `null` = sem IP, ou ainda por sondar. */
  liveState: 'up' | 'down' | null;
  /**
   * As unidades a montante, ou a raiz quando recebe directamente da Internet.
   * Mais do que uma significa agregação multi-WAN: o equipamento soma links.
   * Nunca vazio — sem alimentação declarada, o pai é `root:isp`.
   */
  parentIds: ('root:isp' | `backbone:${number}`)[];
  relationship: 'defined_link';
};

export type TopologyClientDeviceNode = {
  id: `assignment:${number}`;
  kind: 'client-device';
  assignmentId: number;
  catalogId: number;
  label: string;
  brand: string | null;
  model: string;
  catalogType: string;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  startDate: string;
  administrativeState: TopologyAdministrativeState;
  issueCodes: TopologyIssueCode[];
  /** Última leitura da sonda ICMP. `null` = sem IP, ou ainda por sondar. */
  liveState: 'up' | 'down' | null;
  parentId: 'root:isp' | `backbone:${number}`;
  relationship?: TopologyRelationship;
  clients: TopologyClientAssociation[];
};

export type TopologyNode =
  | TopologyLogicalRootNode
  | TopologyBackboneNode
  | TopologyClientDeviceNode;

/** Raiz→backbone ou backbone→backbone: a espinha dorsal, seja qual for a profundidade. */
export type TopologyCoreLinkEdge = {
  id: `core-link:${'root:isp' | `backbone:${number}`}:backbone:${number}`;
  kind: 'core-link';
  source: 'root:isp' | `backbone:${number}`;
  target: `backbone:${number}`;
  relationship: TopologyRelationship;
};

export type TopologyClientLinkEdge = {
  id: `client-link:backbone:${number}:assignment:${number}`;
  kind: 'client-link';
  source: `backbone:${number}`;
  target: `assignment:${number}`;
  relationship: TopologyRelationship;
};

export type TopologyEdge = TopologyCoreLinkEdge | TopologyClientLinkEdge;

export type TopologyStats = {
  backboneCount: number;
  assignmentCount: number;
  mappedAssignmentCount: number;
  unmappedAssignmentCount: number;
  clientCount: number;
  serviceCount: number;
  /**
   * Serviços vivos sem nenhum equipamento instalado. Não são "sem ligação" —
   * não existem no mapa, porque o mapa nasce das atribuições físicas.
   */
  servicesWithoutDeviceCount: number;
  attentionCount: number;
};

export type TopologySnapshot = {
  generatedAt: string;
  root: TopologyLogicalRootNode;
  backbones: TopologyBackboneNode[];
  edges: TopologyCoreLinkEdge[];
  stats: TopologyStats;
};

export type TopologyBackboneBranch = {
  generatedAt: string;
  backbone: TopologyBackboneNode;
  nodes: TopologyClientDeviceNode[];
  edges: TopologyClientLinkEdge[];
  stats: {
    assignmentCount: number;
    clientCount: number;
    serviceCount: number;
    attentionCount: number;
  };
};

export type TopologyAncestor = {
  id: 'root:isp' | `backbone:${number}`;
  kind: 'logical-root' | 'backbone';
  label: string;
  relationship?: TopologyRelationship;
};

export type TopologySearchFilters = {
  administrativeState?: TopologyAdministrativeState;
  attention?: boolean;
  island?: string;
  zone?: string;
};

export type TopologySearchResult = {
  node: TopologyBackboneNode | TopologyClientDeviceNode;
  matchedFields: string[];
  ancestors: TopologyAncestor[];
};

export type TopologySearchResponse = {
  generatedAt: string;
  query: string;
  filters: TopologySearchFilters;
  results: TopologySearchResult[];
};
