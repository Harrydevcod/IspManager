/**
 * O equipamento do cliente que fala directamente com o backbone. O router de
 * casa não é um deles: pende da antena, tal como na instalação real.
 */
export const BACKBONE_UPLINK_TYPES = ['cpe', 'antena'] as const;

/** A mesma lista, pronta a entrar numa cláusula SQL `IN`. */
export const BACKBONE_UPLINK_TYPES_SQL = BACKBONE_UPLINK_TYPES
  .map((type) => `'${type}'`)
  .join(', ');

export type TopologyIssueCode =
  | 'inactive'
  | 'missing_ip'
  | 'suspended_service'
  | 'incomplete_configuration'
  | 'provisional_identity';

export type TopologyAdministrativeState = 'active' | 'inactive';
export type TopologyRelationship = 'defined_link';
/** Cliente: o par com o serviço, porque é o serviço que está ligado ali. */
export type TopologyClientNodeId = `client:${number}@${number}`;
export type TopologyNodeId =
  | 'root:isp'
  | `backbone:${number}`
  | `assignment:${number}`
  | TopologyClientNodeId;

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
  /**
   * O equipamento imediatamente a montante. Uma antena/CPE pende do backbone;
   * o router do cliente pende da antena dele, que é quem fala com o backbone.
   */
  parentId: 'root:isp' | `backbone:${number}` | `assignment:${number}`;
  /**
   * A antena de backbone na raiz do ramo, a vários saltos de distância se for
   * preciso. Guardada em vez de deduzida do `parentId`: quem pende de outro
   * equipamento do cliente não tem o backbone no pai.
   */
  backboneDeviceId: number | null;
  relationship?: TopologyRelationship;
  clients: TopologyClientAssociation[];
};

/**
 * Quem é servido no fim da cadeia. Pende do equipamento mais fundo do serviço —
 * o router de casa quando existe, a antena quando o serviço não tem mais nada.
 * Não tem `liveState`: não se sonda uma pessoa.
 */
export type TopologyClientNode = {
  id: TopologyClientNodeId;
  kind: 'client';
  clientId: number;
  serviceId: number;
  clientCode: string;
  /** O nome do cliente: é isto que se lê no card. */
  label: string;
  island: string | null;
  zone: string | null;
  planName: string | null;
  serviceStatus: 'active' | 'suspended' | 'cancelled';
  administrativeState: TopologyAdministrativeState;
  issueCodes: TopologyIssueCode[];
  parentId: `assignment:${number}`;
};

export type TopologyNode =
  | TopologyLogicalRootNode
  | TopologyBackboneNode
  | TopologyClientDeviceNode
  | TopologyClientNode;

/** Raiz→backbone ou backbone→backbone: a espinha dorsal, seja qual for a profundidade. */
export type TopologyCoreLinkEdge = {
  id: `core-link:${'root:isp' | `backbone:${number}`}:backbone:${number}`;
  kind: 'core-link';
  source: 'root:isp' | `backbone:${number}`;
  target: `backbone:${number}`;
  relationship: TopologyRelationship;
};

/** Backbone→equipamento, ou equipamento→equipamento dentro da casa do cliente. */
export type TopologyClientLinkEdge = {
  id: `client-link:${`backbone:${number}` | `assignment:${number}`}:assignment:${number}`;
  kind: 'client-link';
  source: `backbone:${number}` | `assignment:${number}`;
  target: `assignment:${number}`;
  relationship: TopologyRelationship;
};

/**
 * Equipamento→cliente. Não é um cabo: é titularidade. Espécie própria para o
 * traço poder ser outro — este mapa desenha ligações físicas (ADR 0005), e uma
 * linha destas não pode passar por uma delas.
 */
export type TopologyOwnershipEdge = {
  id: `ownership:assignment:${number}:${TopologyClientNodeId}`;
  kind: 'ownership';
  source: `assignment:${number}`;
  target: TopologyClientNodeId;
  relationship: TopologyRelationship;
};

export type TopologyEdge =
  | TopologyCoreLinkEdge
  | TopologyClientLinkEdge
  | TopologyOwnershipEdge;

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
  /** As pessoas servidas neste ramo. Fora de `nodes` para as contas do ramo
      continuarem a contar equipamento, não gente. */
  clientNodes: TopologyClientNode[];
  edges: (TopologyClientLinkEdge | TopologyOwnershipEdge)[];
  stats: {
    assignmentCount: number;
    clientCount: number;
    serviceCount: number;
    attentionCount: number;
  };
};

export type TopologyAncestor = {
  id: 'root:isp' | `backbone:${number}` | `assignment:${number}`;
  kind: 'logical-root' | 'backbone' | 'client-device';
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
