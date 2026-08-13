import type Database from 'better-sqlite3';
import type {
  TopologyBackboneBranch,
  TopologyBackboneNode,
  TopologyClientAssociation,
  TopologyClientDeviceNode,
  TopologyClientLinkEdge,
  TopologyCoreLinkEdge,
  TopologyIssueCode,
  TopologyServiceAssociation,
  TopologySnapshot,
  TopologyStats
} from '../../shared/topology';

type EquipmentRow = {
  brand: string | null;
  model: string;
  catalogType: string;
};

type BackboneRow = EquipmentRow & {
  backboneDeviceId: number;
  catalogId: number;
  name: string;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  island: string | null;
  zone: string | null;
  status: 'active' | 'maintenance';
  provisional: number;
  liveState: 'up' | 'down' | null;
};

type AssignmentRow = EquipmentRow & {
  catalogId: number;
  active: number;
  assignmentId: number;
  backboneDeviceId: number | null;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  startDate: string;
  isSerialized: number;
  liveState: 'up' | 'down' | null;
};

type AssociationRow = {
  assignmentId: number;
  serviceId: number;
  serviceStatus: 'active' | 'suspended' | 'cancelled';
  planId: number | null;
  planName: string | null;
  clientId: number;
  clientCode: string;
  fullName: string;
  clientStatus: 'active' | 'suspended' | 'cancelled';
  island: string | null;
  zone: string | null;
};

type AggregateRow = {
  assignmentCount: number;
  mappedAssignmentCount: number;
  clientCount: number;
  serviceCount: number;
  servicesWithoutDeviceCount: number;
  assignmentAttentionCount: number;
};

function equipmentLabel(row: Pick<EquipmentRow, 'brand' | 'model'>): string {
  return [row.brand, row.model].filter(Boolean).join(' ');
}

function loadBackboneRows(db: Database.Database): BackboneRow[] {
  return db.prepare(`
    SELECT
      bd.id AS backboneDeviceId, bd.catalog_id AS catalogId, bd.name,
      bd.serial_number AS serialNumber, bd.asset_tag AS assetTag,
      bd.ip_address AS ipAddress, bd.mac_address AS macAddress,
      bd.island, bd.zone, bd.status, bd.provisional,
      ec.brand, ec.model, ec.type AS catalogType,
      probe.state AS liveState
    FROM backbone_devices bd
    JOIN equipment_catalog ec ON ec.id = bd.catalog_id
    LEFT JOIN network_probe_state probe
      ON probe.target_kind = 'backbone' AND probe.target_id = bd.id
    WHERE bd.status <> 'retired'
    ORDER BY bd.name COLLATE NOCASE, bd.id
  `).all() as BackboneRow[];
}

/**
 * As alimentações que ainda estão no mapa, por equipamento. Uma unidade
 * retirada é filtrada da leitura, e sem esta guarda os seus jusantes ficariam
 * pendurados num nó inexistente — nesse caso caem na raiz. Um equipamento
 * multi-WAN devolve várias: cada Starlink é um pai seu.
 */
function loadVisibleUplinks(
  db: Database.Database,
  backboneDeviceId: number | null = null
): Map<number, number[]> {
  const rows = db.prepare(`
    SELECT link.device_id AS deviceId, link.upstream_device_id AS upstreamDeviceId
    FROM backbone_links link
    JOIN backbone_devices up ON up.id = link.upstream_device_id
    WHERE up.status <> 'retired'
      AND (? IS NULL OR link.device_id = ?)
    ORDER BY up.name COLLATE NOCASE, link.upstream_device_id
  `).all(backboneDeviceId, backboneDeviceId) as Array<{ deviceId: number; upstreamDeviceId: number }>;
  const grouped = new Map<number, number[]>();
  for (const row of rows) {
    const current = grouped.get(row.deviceId);
    if (current) current.push(row.upstreamDeviceId);
    else grouped.set(row.deviceId, [row.upstreamDeviceId]);
  }
  return grouped;
}

function loadBackboneRow(
  db: Database.Database,
  backboneDeviceId: number
): BackboneRow | undefined {
  return db.prepare(`
    SELECT
      bd.id AS backboneDeviceId, bd.catalog_id AS catalogId, bd.name,
      bd.serial_number AS serialNumber, bd.asset_tag AS assetTag,
      bd.ip_address AS ipAddress, bd.mac_address AS macAddress,
      bd.island, bd.zone, bd.status, bd.provisional,
      ec.brand, ec.model, ec.type AS catalogType,
      probe.state AS liveState
    FROM backbone_devices bd
    JOIN equipment_catalog ec ON ec.id = bd.catalog_id
    LEFT JOIN network_probe_state probe
      ON probe.target_kind = 'backbone' AND probe.target_id = bd.id
    WHERE bd.id = ? AND bd.status <> 'retired'
  `).get(backboneDeviceId) as BackboneRow | undefined;
}

function loadAssignmentRows(
  db: Database.Database,
  backboneDeviceId: number | null = null
): AssignmentRow[] {
  return db.prepare(`
    SELECT
      a.id AS assignmentId, a.catalog_id AS catalogId, ec.brand, ec.model,
      ec.type AS catalogType, ec.active,
      ec.is_serialized AS isSerialized, a.serial_number AS serialNumber,
      a.asset_tag AS assetTag, a.ip_address AS ipAddress,
      a.mac_address AS macAddress, a.start_date AS startDate,
      active_link.backbone_device_id AS backboneDeviceId,
      probe.state AS liveState
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    LEFT JOIN backbone_assignment_links active_link
      ON active_link.assignment_id = a.id AND active_link.ended_at IS NULL
    LEFT JOIN network_probe_state probe
      ON probe.target_kind = 'assignment' AND probe.target_id = a.id
    WHERE a.end_date IS NULL
      AND (? IS NULL OR active_link.backbone_device_id = ?)
    ORDER BY a.id
  `).all(backboneDeviceId, backboneDeviceId) as AssignmentRow[];
}

function loadAssociationRows(
  db: Database.Database,
  backboneDeviceId: number | null = null
): AssociationRow[] {
  return db.prepare(`
    SELECT
      asv.assignment_id AS assignmentId, s.id AS serviceId,
      s.status AS serviceStatus, s.plan_id AS planId, p.name AS planName,
      c.id AS clientId, c.client_code AS clientCode, c.full_name AS fullName,
      c.status AS clientStatus, c.island, c.zone
    FROM assignment_services asv
    JOIN service_device_assignments a ON a.id = asv.assignment_id
    LEFT JOIN backbone_assignment_links active_link
      ON active_link.assignment_id = a.id AND active_link.ended_at IS NULL
    JOIN services s ON s.id = asv.service_id
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    WHERE a.end_date IS NULL
      AND (? IS NULL OR active_link.backbone_device_id = ?)
    ORDER BY asv.assignment_id, c.full_name COLLATE NOCASE, s.id
  `).all(backboneDeviceId, backboneDeviceId) as AssociationRow[];
}

function serviceFromRow(row: AssociationRow): TopologyServiceAssociation {
  return {
    id: row.serviceId,
    status: row.serviceStatus,
    planId: row.planId,
    planName: row.planName,
    assignmentIds: [row.assignmentId]
  };
}

function clientFromRow(row: AssociationRow): TopologyClientAssociation {
  return {
    id: row.clientId,
    clientCode: row.clientCode,
    fullName: row.fullName,
    status: row.clientStatus,
    island: row.island,
    zone: row.zone,
    services: [serviceFromRow(row)]
  };
}

function appendAssociation(
  clients: Map<number, TopologyClientAssociation>,
  row: AssociationRow
): void {
  const client = clients.get(row.clientId);
  if (!client) {
    clients.set(row.clientId, clientFromRow(row));
    return;
  }
  const service = client.services.find((item) => item.id === row.serviceId);
  if (!service) {
    client.services.push(serviceFromRow(row));
    return;
  }
  if (!service.assignmentIds.includes(row.assignmentId)) {
    service.assignmentIds.push(row.assignmentId);
  }
}

function groupAssociations(rows: AssociationRow[]): Map<number, TopologyClientAssociation[]> {
  const byAssignment = new Map<number, Map<number, TopologyClientAssociation>>();
  for (const row of rows) {
    const clients = byAssignment.get(row.assignmentId) ?? new Map();
    appendAssociation(clients, row);
    byAssignment.set(row.assignmentId, clients);
  }
  return new Map(
    [...byAssignment].map(([id, clients]) => [id, [...clients.values()]])
  );
}

function backboneNode(row: BackboneRow, uplinks: number[] = []): TopologyBackboneNode {
  const inactive = row.status !== 'active';
  const provisional = row.provisional === 1;
  const issueCodes: TopologyIssueCode[] = [];
  if (inactive) issueCodes.push('inactive');
  if (provisional) issueCodes.push('provisional_identity');
  return {
    id: `backbone:${row.backboneDeviceId}`,
    kind: 'backbone',
    backboneDeviceId: row.backboneDeviceId,
    catalogId: row.catalogId,
    label: row.name,
    brand: row.brand,
    model: row.model,
    catalogType: row.catalogType,
    serialNumber: row.serialNumber,
    assetTag: row.assetTag,
    ipAddress: row.ipAddress,
    macAddress: row.macAddress,
    island: row.island,
    zone: row.zone,
    provisional,
    administrativeState: inactive ? 'inactive' : 'active',
    issueCodes,
    liveState: row.liveState,
    parentIds: uplinks.length === 0
      ? ['root:isp']
      : uplinks.map((upstreamId) => `backbone:${upstreamId}` as const),
    relationship: 'defined_link'
  };
}

function clientDeviceIssues(
  row: AssignmentRow,
  clients: TopologyClientAssociation[]
): TopologyIssueCode[] {
  const issues: TopologyIssueCode[] = [];
  if (row.active !== 1) issues.push('inactive');
  if (!row.ipAddress?.trim()) issues.push('missing_ip');
  const services = clients.flatMap((client) => client.services);
  if (services.some((service) => service.status === 'suspended')) {
    issues.push('suspended_service');
  }
  if (row.isSerialized === 1 && !row.serialNumber?.trim()) {
    issues.push('incomplete_configuration');
  }
  return issues;
}

function clientDeviceNode(
  row: AssignmentRow,
  clients: TopologyClientAssociation[]
): TopologyClientDeviceNode {
  const backboneParentId = row.backboneDeviceId === null
    ? null
    : `backbone:${row.backboneDeviceId}` as const;
  return {
    id: `assignment:${row.assignmentId}`,
    kind: 'client-device',
    assignmentId: row.assignmentId,
    catalogId: row.catalogId,
    label: equipmentLabel(row),
    brand: row.brand,
    model: row.model,
    catalogType: row.catalogType,
    serialNumber: row.serialNumber,
    assetTag: row.assetTag,
    ipAddress: row.ipAddress,
    macAddress: row.macAddress,
    startDate: row.startDate,
    administrativeState: row.active === 1 ? 'active' : 'inactive',
    issueCodes: clientDeviceIssues(row, clients),
    liveState: row.liveState,
    parentId: backboneParentId ?? 'root:isp',
    relationship: backboneParentId ? 'defined_link' : undefined,
    clients
  };
}

function loadAggregateRow(db: Database.Database): AggregateRow {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM service_device_assignments WHERE end_date IS NULL)
        AS assignmentCount,
      (SELECT COUNT(*)
       FROM service_device_assignments a
       WHERE a.end_date IS NULL AND EXISTS (
         SELECT 1
         FROM backbone_assignment_links active_link
         WHERE active_link.assignment_id = a.id AND active_link.ended_at IS NULL
       ))
        AS mappedAssignmentCount,
      (SELECT COUNT(DISTINCT s.client_id)
       FROM assignment_services av
       JOIN service_device_assignments a ON a.id = av.assignment_id
       JOIN services s ON s.id = av.service_id
       WHERE a.end_date IS NULL) AS clientCount,
      (SELECT COUNT(DISTINCT av.service_id)
       FROM assignment_services av
       JOIN service_device_assignments a ON a.id = av.assignment_id
       WHERE a.end_date IS NULL) AS serviceCount,
      -- Um serviço sem equipamento instalado não é "sem ligação": não existe de
      -- todo no mapa, que nasce das atribuições. Sem esta contagem, um serviço
      -- criado sem equipamento desaparecia sem ninguém dar por isso.
      (SELECT COUNT(*)
       FROM services s
       JOIN clients c ON c.id = s.client_id
       WHERE s.status <> 'cancelled' AND c.status <> 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM assignment_services av
           JOIN service_device_assignments a ON a.id = av.assignment_id
           WHERE av.service_id = s.id AND a.end_date IS NULL
         )) AS servicesWithoutDeviceCount,
      (SELECT COUNT(DISTINCT a.id)
       FROM service_device_assignments a
       JOIN equipment_catalog ec ON ec.id = a.catalog_id
       WHERE a.end_date IS NULL AND (
         ec.active <> 1
         OR NULLIF(TRIM(a.ip_address), '') IS NULL
         OR (ec.is_serialized = 1 AND NULLIF(TRIM(a.serial_number), '') IS NULL)
         OR EXISTS (
           SELECT 1 FROM assignment_services av
           JOIN services s ON s.id = av.service_id
           WHERE av.assignment_id = a.id AND s.status = 'suspended'
         )
       )) AS assignmentAttentionCount
  `).get() as AggregateRow;
}

function topologyStats(
  db: Database.Database,
  backbones: TopologyBackboneNode[]
): TopologyStats {
  const aggregate = loadAggregateRow(db);
  const backboneAttention = backbones.filter((node) => node.issueCodes.length > 0).length;
  return {
    backboneCount: backbones.length,
    assignmentCount: aggregate.assignmentCount,
    mappedAssignmentCount: aggregate.mappedAssignmentCount,
    unmappedAssignmentCount: aggregate.assignmentCount - aggregate.mappedAssignmentCount,
    clientCount: aggregate.clientCount,
    serviceCount: aggregate.serviceCount,
    servicesWithoutDeviceCount: aggregate.servicesWithoutDeviceCount,
    attentionCount: backboneAttention + aggregate.assignmentAttentionCount
  };
}

/** Uma aresta por alimentação: num router multi-WAN convergem várias. */
function coreLinks(backbone: TopologyBackboneNode): TopologyCoreLinkEdge[] {
  return backbone.parentIds.map((parentId) => ({
    id: `core-link:${parentId}:backbone:${backbone.backboneDeviceId}`,
    kind: 'core-link',
    source: parentId,
    target: backbone.id,
    relationship: 'defined_link'
  }));
}

function clientLink(
  backbone: TopologyBackboneNode,
  node: TopologyClientDeviceNode
): TopologyClientLinkEdge {
  return {
    id: `client-link:backbone:${backbone.backboneDeviceId}:assignment:${node.assignmentId}`,
    kind: 'client-link',
    source: backbone.id,
    target: node.id,
    relationship: 'defined_link'
  };
}

function buildClientDevices(
  rows: AssignmentRow[],
  associations: AssociationRow[]
): TopologyClientDeviceNode[] {
  const grouped = groupAssociations(associations);
  return rows.map((row) => clientDeviceNode(
    row,
    grouped.get(row.assignmentId) ?? []
  ));
}

function branchStats(nodes: TopologyClientDeviceNode[]) {
  const clients = new Set<number>();
  const services = new Set<number>();
  for (const node of nodes) {
    for (const client of node.clients) {
      clients.add(client.id);
      client.services.forEach((service) => services.add(service.id));
    }
  }
  return {
    assignmentCount: nodes.length,
    clientCount: clients.size,
    serviceCount: services.size,
    attentionCount: nodes.filter((node) => node.issueCodes.length > 0).length
  };
}

export function loadTopologySnapshot(
  db: Database.Database,
  now = new Date()
): TopologySnapshot {
  const uplinks = loadVisibleUplinks(db);
  const backbones = loadBackboneRows(db)
    .map((row) => backboneNode(row, uplinks.get(row.backboneDeviceId) ?? []));
  return {
    generatedAt: now.toISOString(),
    root: {
      id: 'root:isp',
      kind: 'logical-root',
      label: 'Internet',
      administrativeState: 'active',
      issueCodes: []
    },
    backbones,
    edges: backbones.flatMap(coreLinks),
    stats: topologyStats(db, backbones)
  };
}

export function loadBackboneBranch(
  db: Database.Database,
  backboneDeviceId: number,
  now = new Date()
): TopologyBackboneBranch | null {
  const row = loadBackboneRow(db, backboneDeviceId);
  if (!row) return null;
  const backbone = backboneNode(row, loadVisibleUplinks(db, backboneDeviceId).get(backboneDeviceId) ?? []);
  const nodes = buildClientDevices(
    loadAssignmentRows(db, backboneDeviceId),
    loadAssociationRows(db, backboneDeviceId)
  );
  return {
    generatedAt: now.toISOString(),
    backbone,
    nodes,
    edges: nodes.map((node) => clientLink(backbone, node)),
    stats: branchStats(nodes)
  };
}

export function loadSearchableTopologyNodes(db: Database.Database): {
  backbones: TopologyBackboneNode[];
  clientDevices: TopologyClientDeviceNode[];
} {
  const uplinks = loadVisibleUplinks(db);
  return {
    backbones: loadBackboneRows(db)
      .map((row) => backboneNode(row, uplinks.get(row.backboneDeviceId) ?? [])),
    clientDevices: buildClientDevices(
      loadAssignmentRows(db),
      loadAssociationRows(db)
    )
  };
}
