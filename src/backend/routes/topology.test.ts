import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

type Fixture = {
  backboneDeviceId: number;
  provisionalBackboneDeviceId: number;
  retiredBackboneDeviceId: number;
  backboneCatalogId: number;
  clientCatalogId: number;
  sharedAssignmentId: number;
  incompleteAssignmentId: number;
  inactiveAssignmentId: number;
};

const TABLES_TO_CLEAR = [
  'backbone_assignment_links',
  // Antes das unidades: as ligações apontam para elas com FK RESTRICT.
  'backbone_links',
  'backbone_devices',
  'service_device_shares',
  'service_device_assignments',
  'services',
  'internet_plans',
  'equipment_catalog',
  'clients'
];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-topology-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of TABLES_TO_CLEAR) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

function insertCatalog(values: {
  model: string;
  type: string;
  active?: number;
  serialized?: number;
}) {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog (
      category, type, brand, model, active, is_serialized, stock_total
    ) VALUES ('equipamento', ?, 'Ubiquiti', ?, ?, ?, 10)
  `).run(
    values.type,
    values.model,
    values.active ?? 1,
    values.serialized ?? 1
  ).lastInsertRowid);
}

function insertClient(code: string, name: string, status: string, island: string, zone: string) {
  return Number(db.prepare(`
    INSERT INTO clients (client_code, full_name, status, island, zone)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, name, status, island, zone).lastInsertRowid);
}

function insertService(clientId: number, planId: number, status: string) {
  return Number(db.prepare(`
    INSERT INTO services (client_id, plan_id, monthly_value_cve, status)
    VALUES (?, ?, 3500, ?)
  `).run(clientId, planId, status).lastInsertRowid);
}

function insertAssignment(values: {
  serviceId: number;
  catalogId: number;
  serial?: string | null;
  ip?: string | null;
  mac?: string | null;
  ended?: boolean;
}) {
  return Number(db.prepare(`
    INSERT INTO service_device_assignments (
      service_id, catalog_id, serial_number, ip_address, mac_address, end_date
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    values.serviceId,
    values.catalogId,
    values.serial ?? null,
    values.ip ?? null,
    values.mac ?? null,
    values.ended ? '2026-07-01' : null
  ).lastInsertRowid);
}

function insertBackboneDevice(values: {
  id: number;
  catalogId: number;
  name: string;
  status?: 'active' | 'maintenance' | 'retired';
  provisional?: boolean;
  serial?: string | null;
  assetTag?: string | null;
  ip?: string | null;
  mac?: string | null;
  island?: string | null;
  zone?: string | null;
  upstreamDeviceId?: number | null;
}) {
  db.prepare(`
    INSERT INTO backbone_devices (
      id, catalog_id, name, status, provisional, serial_number, asset_tag,
      ip_address, mac_address, island, zone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.id,
    values.catalogId,
    values.name,
    values.status ?? 'active',
    values.provisional ? 1 : 0,
    values.serial ?? null,
    values.assetTag ?? null,
    values.ip ?? null,
    values.mac ?? null,
    values.island ?? null,
    values.zone ?? null
  );
  if (values.upstreamDeviceId != null) linkUpstream(values.id, values.upstreamDeviceId);
  return values.id;
}

/** Declara "este equipamento recebe sinal daquele". Várias vezes = multi-WAN. */
function linkUpstream(deviceId: number, upstreamDeviceId: number) {
  db.prepare(`
    INSERT INTO backbone_links (device_id, upstream_device_id) VALUES (?, ?)
  `).run(deviceId, upstreamDeviceId);
}

function linkAssignment(
  backboneDeviceId: number,
  assignmentId: number,
  endedAt: string | null = null
) {
  db.prepare(`
    INSERT INTO backbone_assignment_links (
      backbone_device_id, assignment_id, started_at, ended_at
    ) VALUES (?, ?, '2026-07-01', ?)
  `).run(backboneDeviceId, assignmentId, endedAt);
}

function seedTopology(): Fixture {
  const backboneCatalogId = insertCatalog({
    model: 'Rocket Prism 5AC',
    type: 'antena'
  });
  const provisionalBackboneCatalogId = insertCatalog({
    model: 'Core Switch Legacy',
    type: 'switch',
    serialized: 0
  });
  const clientCatalogId = insertCatalog({
    model: 'LiteBeam 5AC',
    type: 'cpe'
  });
  const inactiveClientCatalogId = insertCatalog({
    model: 'NanoStation Legacy',
    type: 'cpe',
    active: 0,
    serialized: 0
  });
  const backboneDeviceId = insertBackboneDevice({
    id: 701,
    catalogId: backboneCatalogId,
    name: 'Monte Verde Principal',
    serial: 'BB-MV-001',
    assetTag: 'AT-MV-001',
    ip: '10.10.0.1',
    mac: 'AA:BB:CC:00:00:01',
    island: 'São Vicente',
    zone: 'Monte Verde'
  });
  const provisionalBackboneDeviceId = insertBackboneDevice({
    id: 702,
    catalogId: provisionalBackboneCatalogId,
    name: 'Core Switch Legacy',
    status: 'maintenance',
    provisional: true
  });
  const retiredBackboneDeviceId = insertBackboneDevice({
    id: 703,
    catalogId: backboneCatalogId,
    name: 'Backbone Retirado',
    status: 'retired'
  });
  const planId = Number(db.prepare(`
    INSERT INTO internet_plans (name, download_speed, upload_speed, connection_type)
    VALUES ('Fibra Pro', '100 Mbps', '50 Mbps', 'fibra')
  `).run().lastInsertRowid);
  const joseId = insertClient('CLI-001', 'José Andrade', 'active', 'São Vicente', 'Mindelo');
  const mariaId = insertClient('CLI-002', 'Maria Silva', 'active', 'Santiago', 'Plateau');
  const anaId = insertClient('CLI-003', 'Ana Lopes', 'suspended', 'Sal', 'Espargos');
  const joseServiceId = insertService(joseId, planId, 'active');
  const mariaServiceId = insertService(mariaId, planId, 'active');
  const anaServiceId = insertService(anaId, planId, 'suspended');
  const sharedAssignmentId = insertAssignment({
    serviceId: joseServiceId,
    catalogId: clientCatalogId,
    serial: 'SN-CORE-001',
    ip: '10.20.30.40',
    mac: 'AA:BB:CC:DD:EE:01'
  });
  db.prepare(`
    INSERT INTO service_device_shares (assignment_id, service_id) VALUES (?, ?)
  `).run(sharedAssignmentId, anaServiceId);
  const incompleteAssignmentId = insertAssignment({
    serviceId: mariaServiceId,
    catalogId: clientCatalogId
  });
  const inactiveAssignmentId = insertAssignment({
    serviceId: mariaServiceId,
    catalogId: inactiveClientCatalogId,
    serial: 'SN-LEGACY',
    ip: '10.0.0.9'
  });
  const endedAssignmentId = insertAssignment({
    serviceId: joseServiceId,
    catalogId: clientCatalogId,
    serial: 'SN-ENDED',
    ip: '10.20.30.99',
    ended: true
  });
  linkAssignment(backboneDeviceId, sharedAssignmentId);
  linkAssignment(backboneDeviceId, incompleteAssignmentId, '2026-07-15');
  linkAssignment(provisionalBackboneDeviceId, inactiveAssignmentId);
  linkAssignment(provisionalBackboneDeviceId, endedAssignmentId);
  return {
    backboneDeviceId,
    provisionalBackboneDeviceId,
    retiredBackboneDeviceId,
    backboneCatalogId,
    clientCatalogId,
    sharedAssignmentId,
    incompleteAssignmentId,
    inactiveAssignmentId
  };
}

describe('GET /api/topology', () => {
  test('returns only the logical root, backbones, core edges, factual stats and timestamp', async () => {
    const fixture = seedTopology();
    const response = await app.inject({ method: 'GET', url: '/api/topology' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      'backbones',
      'edges',
      'generatedAt',
      'root',
      'stats'
    ]);
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.root).toMatchObject({
      id: 'root:isp',
      kind: 'logical-root',
      label: 'Internet',
      administrativeState: 'active',
      issueCodes: []
    });
    expect(body.stats).toEqual({
      backboneCount: 2,
      assignmentCount: 3,
      // A CPE sem link do serviço da Maria fica atrás da que está ligada, como
      // um ponto de acesso na segunda saída — logo também chega ao backbone.
      mappedAssignmentCount: 3,
      unmappedAssignmentCount: 0,
      clientCount: 3,
      serviceCount: 3,
      servicesWithoutDeviceCount: 0,
      attentionCount: 4
    });
    expect(body.backbones).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `backbone:${fixture.backboneDeviceId}`,
        kind: 'backbone',
        backboneDeviceId: fixture.backboneDeviceId,
        catalogId: fixture.backboneCatalogId,
        label: 'Monte Verde Principal',
        relationship: 'defined_link',
        serialNumber: 'BB-MV-001',
        assetTag: 'AT-MV-001',
        ipAddress: '10.10.0.1',
        macAddress: 'AA:BB:CC:00:00:01',
        island: 'São Vicente',
        zone: 'Monte Verde',
        provisional: false,
        issueCodes: []
      }),
      expect.objectContaining({
        id: `backbone:${fixture.provisionalBackboneDeviceId}`,
        backboneDeviceId: fixture.provisionalBackboneDeviceId,
        administrativeState: 'inactive',
        provisional: true,
        issueCodes: ['inactive', 'provisional_identity']
      })
    ]));
    expect(body.backbones.every(
      (backbone: Record<string, unknown>) => !('backboneQty' in backbone)
    )).toBe(true);
    expect(body.backbones).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ backboneDeviceId: fixture.retiredBackboneDeviceId })
    ]));
    expect(body.edges).toHaveLength(2);
    expect(body.edges).toEqual(expect.arrayContaining([
      {
        id: `core-link:root:isp:backbone:${fixture.backboneDeviceId}`,
        kind: 'core-link',
        source: 'root:isp',
        target: `backbone:${fixture.backboneDeviceId}`,
        relationship: 'defined_link'
      },
      {
        id: `core-link:root:isp:backbone:${fixture.provisionalBackboneDeviceId}`,
        kind: 'core-link',
        source: 'root:isp',
        target: `backbone:${fixture.provisionalBackboneDeviceId}`,
        relationship: 'defined_link'
      }
    ]));
  });

  test('hangs each backbone on its upstream and falls back to the root when that unit is retired', async () => {
    const fixture = seedTopology();
    // Starlink alimenta o Monte Verde; o provisório é alimentado por uma unidade
    // retirada, logo não pode ficar pendurado num nó ausente do mapa.
    const starlinkId = insertBackboneDevice({
      id: 704,
      catalogId: fixture.backboneCatalogId,
      name: 'Starlink Standard',
      serial: 'BB-STL-001'
    });
    linkUpstream(fixture.backboneDeviceId, starlinkId);
    linkUpstream(fixture.provisionalBackboneDeviceId, fixture.retiredBackboneDeviceId);

    const body = (await app.inject({ method: 'GET', url: '/api/topology' })).json();

    expect(body.backbones).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `backbone:${fixture.backboneDeviceId}`,
        parentIds: [`backbone:${starlinkId}`]
      }),
      expect.objectContaining({ id: `backbone:${starlinkId}`, parentIds: ['root:isp'] }),
      expect.objectContaining({
        id: `backbone:${fixture.provisionalBackboneDeviceId}`,
        parentIds: ['root:isp']
      })
    ]));
    expect(body.edges).toEqual(expect.arrayContaining([{
      id: `core-link:backbone:${starlinkId}:backbone:${fixture.backboneDeviceId}`,
      kind: 'core-link',
      source: `backbone:${starlinkId}`,
      target: `backbone:${fixture.backboneDeviceId}`,
      relationship: 'defined_link'
    }]));
  });

  test('keeps every internet uplink at the root and lets them converge on one multi-WAN unit', async () => {
    const fixture = seedTopology();
    // Reforço de capacidade: duas Starlink na base da Internet, agregadas no
    // mesmo router. O nó "Internet" é lógico e soma as origens que existirem.
    const firstId = insertBackboneDevice({
      id: 704, catalogId: fixture.backboneCatalogId, name: 'Starlink 1', serial: 'BB-STL-001'
    });
    const secondId = insertBackboneDevice({
      id: 705, catalogId: fixture.backboneCatalogId, name: 'Starlink 2', serial: 'BB-STL-002'
    });
    const routerId = insertBackboneDevice({
      id: 706, catalogId: fixture.backboneCatalogId, name: 'Router multi-WAN', serial: 'BB-RTR-001'
    });
    linkUpstream(routerId, firstId);
    linkUpstream(routerId, secondId);

    const body = (await app.inject({ method: 'GET', url: '/api/topology' })).json();

    expect(body.backbones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `backbone:${firstId}`, parentIds: ['root:isp'] }),
      expect.objectContaining({ id: `backbone:${secondId}`, parentIds: ['root:isp'] }),
      expect.objectContaining({
        id: `backbone:${routerId}`,
        parentIds: [`backbone:${firstId}`, `backbone:${secondId}`]
      })
    ]));
    // Duas arestas convergem no router; ambas as antenas continuam na raiz.
    expect(body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: `backbone:${firstId}`, target: `backbone:${routerId}`
      }),
      expect.objectContaining({
        source: `backbone:${secondId}`, target: `backbone:${routerId}`
      }),
      expect.objectContaining({ source: 'root:isp', target: `backbone:${firstId}` }),
      expect.objectContaining({ source: 'root:isp', target: `backbone:${secondId}` })
    ]));
    expect(body.edges.filter((edge: { target: string }) => (
      edge.target === `backbone:${routerId}`
    ))).toHaveLength(2);
  });

  test('counts live services with no equipment, which the map cannot draw at all', async () => {
    seedTopology();
    const planId = (db.prepare('SELECT id FROM internet_plans LIMIT 1').get() as { id: number }).id;
    const clientId = insertClient('CLI-004', 'Cliente Sem CPE', 'active', 'São Vicente', 'Mindelo');
    const serviceId = insertService(clientId, planId, 'active');
    // Um serviço cancelado não é uma dívida por resolver — fica de fora.
    const goneId = insertClient('CLI-005', 'Cliente Saiu', 'cancelled', 'São Vicente', 'Mindelo');
    insertService(goneId, planId, 'cancelled');

    const body = (await app.inject({ method: 'GET', url: '/api/topology' })).json();

    // Sem atribuição física não há nó nenhum: o serviço não é sequer "sem ligação".
    expect(body.stats.servicesWithoutDeviceCount).toBe(1);
    expect(body.stats.assignmentCount).toBe(3);
    expect(JSON.stringify(body)).not.toContain(`assignment:${serviceId}`);
  });

  test('keeps every physical device and association out of the lazy initial payload', async () => {
    seedTopology();
    const body = (await app.inject({ method: 'GET', url: '/api/topology' })).json();

    expect(body).not.toHaveProperty('assignments');
    expect(body).not.toHaveProperty('nodes');
    expect(JSON.stringify(body)).not.toContain('SN-CORE-001');
    expect(JSON.stringify(body)).not.toContain('José Andrade');
  });
});

describe('GET /api/topology/backbones/:id/clients', () => {
  test('returns one physical client-device with every owner/share association and its client edge', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const response = await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${backboneDeviceId}/clients`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.backbone).toMatchObject({
      id: `backbone:${backboneDeviceId}`,
      backboneDeviceId,
      relationship: 'defined_link'
    });
    expect(body.stats).toEqual({
      assignmentCount: 1,
      clientCount: 2,
      serviceCount: 2,
      attentionCount: 1
    });
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({
      id: `assignment:${sharedAssignmentId}`,
      kind: 'client-device',
      assignmentId: sharedAssignmentId,
      parentId: `backbone:${backboneDeviceId}`,
      relationship: 'defined_link',
      ipAddress: '10.20.30.40',
      issueCodes: ['suspended_service']
    });
    expect(body.nodes[0].clients).toHaveLength(2);
    expect(body.nodes[0].clients.map((client: { clientCode: string }) => client.clientCode).sort())
      .toEqual(['CLI-001', 'CLI-003']);
    expect(body.nodes[0].clients.flatMap((client: { services: Array<{ assignmentIds: number[] }> }) => (
      client.services.flatMap((service) => service.assignmentIds)
    ))).toEqual([sharedAssignmentId, sharedAssignmentId]);
    expect(body.edges).toEqual([{
      id: `client-link:backbone:${backboneDeviceId}:assignment:${sharedAssignmentId}`,
      kind: 'client-link',
      source: `backbone:${backboneDeviceId}`,
      target: `assignment:${sharedAssignmentId}`,
      relationship: 'defined_link'
    }, ...body.clientNodes.map((client: { id: string }) => ({
      id: `ownership:assignment:${sharedAssignmentId}:${client.id}`,
      kind: 'ownership',
      source: `assignment:${sharedAssignmentId}`,
      target: client.id,
      relationship: 'defined_link'
    }))]);
    // Antena partilhada: dois donos, dois cards, ambos pendurados nela.
    expect(body.clientNodes).toHaveLength(2);
    expect(body.clientNodes.map((client: { clientCode: string }) => client.clientCode).sort())
      .toEqual(['CLI-001', 'CLI-003']);
    expect(body.clientNodes.every((client: { parentId: string }) => (
      client.parentId === `assignment:${sharedAssignmentId}`
    ))).toBe(true);
    expect(body).not.toHaveProperty('clients');
  });

  test('excludes ended assignments even when their explicit link is still active', async () => {
    const {
      provisionalBackboneDeviceId, inactiveAssignmentId, incompleteAssignmentId
    } = seedTopology();
    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${provisionalBackboneDeviceId}/clients`
    })).json();

    // A atribuição terminada fica de fora; a que perdeu o link fica atrás da que
    // ainda o tem, porque continua instalada no mesmo serviço.
    expect(body.nodes.map((node: { assignmentId: number }) => node.assignmentId).sort())
      .toEqual([incompleteAssignmentId, inactiveAssignmentId].sort());
    expect(body.stats).toEqual({
      assignmentCount: 2,
      clientCount: 1,
      serviceCount: 1,
      attentionCount: 2
    });
  });

  /**
   * O router de casa liga-se à antena do cliente, e é essa antena que fala com
   * o backbone. Desenhá-lo ao lado da antena punha o cliente duas vezes no mapa.
   */
  test('hangs the client router on the client antenna instead of the backbone', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const serviceId = (db.prepare(
      'SELECT service_id AS id FROM service_device_assignments WHERE id = ?'
    ).get(sharedAssignmentId) as { id: number }).id;
    const routerAssignmentId = insertAssignment({
      serviceId,
      catalogId: insertCatalog({ model: 'Archer C20', type: 'router', serialized: 0 }),
      ip: '192.168.0.1'
    });

    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${backboneDeviceId}/clients`
    })).json();

    expect(body.nodes.map((node: { assignmentId: number }) => node.assignmentId).sort())
      .toEqual([sharedAssignmentId, routerAssignmentId].sort());
    expect(body.nodes.find((node: { assignmentId: number }) => (
      node.assignmentId === routerAssignmentId
    ))).toMatchObject({
      parentId: `assignment:${sharedAssignmentId}`,
      backboneDeviceId,
      relationship: 'defined_link'
    });
    expect(body.edges).toContainEqual({
      id: `client-link:assignment:${sharedAssignmentId}:assignment:${routerAssignmentId}`,
      kind: 'client-link',
      source: `assignment:${sharedAssignmentId}`,
      target: `assignment:${routerAssignmentId}`,
      relationship: 'defined_link'
    });
    expect(body.stats.assignmentCount).toBe(2);
  });

  /** Entrada antiga, feita quando nada impedia ligar um router ao backbone. */
  test('keeps a wrongly linked router under the antenna it is really behind', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const serviceId = (db.prepare(
      'SELECT service_id AS id FROM service_device_assignments WHERE id = ?'
    ).get(sharedAssignmentId) as { id: number }).id;
    const routerAssignmentId = insertAssignment({
      serviceId,
      catalogId: insertCatalog({ model: 'AC12', type: 'router', serialized: 0 }),
      ip: '192.168.0.2'
    });
    linkAssignment(backboneDeviceId, routerAssignmentId);

    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${backboneDeviceId}/clients`
    })).json();

    expect(body.nodes.find((node: { assignmentId: number }) => (
      node.assignmentId === routerAssignmentId
    )).parentId).toBe(`assignment:${sharedAssignmentId}`);
    expect(body.edges.map((edge: { id: string }) => edge.id))
      .not.toContain(`client-link:backbone:${backboneDeviceId}:assignment:${routerAssignmentId}`);
  });

  /** Antena partilhada: o vizinho chega à antena pelo serviço dele. */
  test('finds the shared antenna from the neighbour service', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const neighbourServiceId = (db.prepare(`
      SELECT service_id AS id FROM service_device_shares WHERE assignment_id = ?
    `).get(sharedAssignmentId) as { id: number }).id;
    const routerAssignmentId = insertAssignment({
      serviceId: neighbourServiceId,
      catalogId: insertCatalog({ model: 'MW325R', type: 'router', serialized: 0 }),
      ip: '192.168.0.3'
    });

    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${backboneDeviceId}/clients`
    })).json();

    expect(body.nodes.find((node: { assignmentId: number }) => (
      node.assignmentId === routerAssignmentId
    )).parentId).toBe(`assignment:${sharedAssignmentId}`);
  });

  /** O caso comum: a cadeia do cliente acaba no router de casa dele. */
  test('ends the chain on the client, hanging from the deepest device of the service', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const serviceId = (db.prepare(
      'SELECT service_id AS id FROM service_device_assignments WHERE id = ?'
    ).get(sharedAssignmentId) as { id: number }).id;
    const routerAssignmentId = insertAssignment({
      serviceId,
      catalogId: insertCatalog({ model: 'Archer C20', type: 'router', serialized: 0 }),
      ip: '192.168.0.1'
    });

    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${backboneDeviceId}/clients`
    })).json();
    const owner = body.clientNodes.find((client: { clientCode: string }) => (
      client.clientCode === 'CLI-001'
    ));

    expect(owner).toMatchObject({
      kind: 'client',
      label: 'José Andrade',
      parentId: `assignment:${routerAssignmentId}`,
      planName: 'Fibra Pro',
      serviceStatus: 'active',
      administrativeState: 'active'
    });
    expect(body.edges).toContainEqual({
      id: `ownership:assignment:${routerAssignmentId}:${owner.id}`,
      kind: 'ownership',
      source: `assignment:${routerAssignmentId}`,
      target: owner.id,
      relationship: 'defined_link'
    });
    // As contas do ramo contam equipamento, não gente.
    expect(body.stats.assignmentCount).toBe(2);
  });

  /**
   * O ponto de acesso ligado à segunda saída de rede da antena. No catálogo é
   * uma antena como outra qualquer — o que o distingue é não ter link ao
   * backbone. Pelo tipo ficava órfão; pela ligação fica onde está montado.
   */
  test('hangs an access point on the antenna it is plugged into, not on the root', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const neighbourServiceId = (db.prepare(`
      SELECT service_id AS id FROM service_device_shares WHERE assignment_id = ?
    `).get(sharedAssignmentId) as { id: number }).id;
    const accessPointId = insertAssignment({
      serviceId: neighbourServiceId,
      catalogId: insertCatalog({ model: 'NanoStation AC Loco', type: 'antena' }),
      serial: 'SN-AP-001',
      ip: '192.168.0.9'
    });

    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${backboneDeviceId}/clients`
    })).json();

    expect(body.nodes.find((node: { assignmentId: number }) => (
      node.assignmentId === accessPointId
    ))).toMatchObject({
      parentId: `assignment:${sharedAssignmentId}`,
      backboneDeviceId,
      relationship: 'defined_link'
    });
    // E o vizinho passa a pender do ponto de acesso: a cadeia dele acaba ali.
    expect(body.clientNodes.find((client: { clientCode: string }) => (
      client.clientCode === 'CLI-003'
    ))).toMatchObject({ parentId: `assignment:${accessPointId}` });
    // O titular continua pendurado na antena: o AP é do vizinho, não dele.
    expect(body.clientNodes.find((client: { clientCode: string }) => (
      client.clientCode === 'CLI-001'
    ))).toMatchObject({ parentId: `assignment:${sharedAssignmentId}` });
  });

  test.each([
    ['/api/topology/backbones/not-a-number/clients', 400],
    ['/api/topology/backbones/0/clients', 400],
    ['/api/topology/backbones/999999/clients', 404]
  ])('isolates invalid or missing backbone handling for %s', async (url, statusCode) => {
    seedTopology();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(statusCode);
  });

  test('treats a catalog id without a physical backbone device as a missing backbone', async () => {
    const { clientCatalogId } = seedTopology();
    const response = await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${clientCatalogId}/clients`
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/topology/search', () => {
  test.each([
    ['jose andrade', 'client-device'],
    ['cli-001', 'client-device'],
    ['10.20.30.40', 'client-device'],
    ['aa:bb:cc:dd:ee:01', 'client-device'],
    ['sn-core-001', 'client-device'],
    ['sao vicente', 'client-device'],
    ['mindelo', 'client-device'],
    ['rocket prism', 'backbone']
  ])('searches normalized topology data for %s', async (query, expectedKind) => {
    seedTopology();
    const response = await app.inject({
      method: 'GET',
      url: `/api/topology/search?q=${encodeURIComponent(query)}`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results.some((result: { node: { kind: string } }) => (
      result.node.kind === expectedKind
    ))).toBe(true);
  });

  test('returns the explicitly linked physical backbone as ancestor', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const body = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=CLI-001'
    })).json();
    const result = body.results.find((item: { node: { assignmentId?: number } }) => (
      item.node.assignmentId === sharedAssignmentId
    ));

    expect(result.ancestors).toEqual([
      { id: 'root:isp', kind: 'logical-root', label: 'Internet' },
      {
        id: `backbone:${backboneDeviceId}`,
        kind: 'backbone',
        label: 'Monte Verde Principal',
        relationship: 'defined_link'
      }
    ]);
  });

  test('puts the client antenna in the chain of the router behind it', async () => {
    const { backboneDeviceId, sharedAssignmentId } = seedTopology();
    const serviceId = (db.prepare(
      'SELECT service_id AS id FROM service_device_assignments WHERE id = ?'
    ).get(sharedAssignmentId) as { id: number }).id;
    const routerAssignmentId = insertAssignment({
      serviceId,
      catalogId: insertCatalog({ model: 'Archer C20', type: 'router', serialized: 0 }),
      ip: '192.168.0.1'
    });

    const body = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=CLI-001'
    })).json();
    const result = body.results.find((item: { node: { assignmentId?: number } }) => (
      item.node.assignmentId === routerAssignmentId
    ));

    expect(result.ancestors).toEqual([
      { id: 'root:isp', kind: 'logical-root', label: 'Internet' },
      {
        id: `backbone:${backboneDeviceId}`,
        kind: 'backbone',
        label: 'Monte Verde Principal',
        relationship: 'defined_link'
      },
      {
        id: `assignment:${sharedAssignmentId}`,
        kind: 'client-device',
        label: 'Ubiquiti LiteBeam 5AC',
        relationship: 'defined_link'
      }
    ]);
  });

  test('returns the whole upstream chain as ancestors, ordered from the root down', async () => {
    const { backboneDeviceId, backboneCatalogId, sharedAssignmentId } = seedTopology();
    const starlinkId = insertBackboneDevice({
      id: 704, catalogId: backboneCatalogId, name: 'Starlink Standard', serial: 'BB-STL-001'
    });
    const routerId = insertBackboneDevice({
      id: 705,
      catalogId: backboneCatalogId,
      name: 'Router Starlink',
      serial: 'BB-RTR-001',
      upstreamDeviceId: starlinkId
    });
    linkUpstream(backboneDeviceId, routerId);

    const body = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=CLI-001'
    })).json();
    const result = body.results.find((item: { node: { assignmentId?: number } }) => (
      item.node.assignmentId === sharedAssignmentId
    ));

    expect(result.ancestors).toEqual([
      { id: 'root:isp', kind: 'logical-root', label: 'Internet' },
      { id: `backbone:${starlinkId}`, kind: 'backbone', label: 'Starlink Standard', relationship: 'defined_link' },
      { id: `backbone:${routerId}`, kind: 'backbone', label: 'Router Starlink', relationship: 'defined_link' },
      { id: `backbone:${backboneDeviceId}`, kind: 'backbone', label: 'Monte Verde Principal', relationship: 'defined_link' }
    ]);
  });

  test('keeps CPE without a factual backbone lineage attached only to the logical root', async () => {
    const fixture = seedTopology();
    // Sozinha no serviço dela: sem antena ligada por perto, não há de onde pender.
    const planId = (db.prepare('SELECT id FROM internet_plans LIMIT 1').get() as { id: number }).id;
    const orphanClientId = insertClient('CLI-006', 'Cliente Sem Antena', 'active', 'Sal', 'Espargos');
    const orphanAssignmentId = insertAssignment({
      serviceId: insertService(orphanClientId, planId, 'active'),
      catalogId: fixture.clientCatalogId,
      serial: 'SN-ORPHAN'
    });
    const body = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=litebeam'
    })).json();
    const result = body.results.find((item: { node: { assignmentId?: number } }) => (
      item.node.assignmentId === orphanAssignmentId
    ));

    expect(result.node).toMatchObject({
      id: `assignment:${orphanAssignmentId}`,
      kind: 'client-device',
      parentId: 'root:isp'
    });
    expect(result.node).not.toHaveProperty('relationship');
    expect(result.ancestors).toEqual([
      { id: 'root:isp', kind: 'logical-root', label: 'Internet' }
    ]);
  });

  test('applies administrative state, attention, island and zone filters', async () => {
    const fixture = seedTopology();
    const inactive = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=legacy&administrativeState=inactive&attention=true'
    })).json();
    expect(inactive.results).toHaveLength(2);
    expect(inactive.results.every((item: { node: { administrativeState: string } }) => (
      item.node.administrativeState === 'inactive'
    ))).toBe(true);

    const location = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=jose&island=S%C3%A3o%20Vicente&zone=Mindelo'
    })).json();
    expect(location.results).toHaveLength(1);
    expect(location.results[0].node.assignmentId).toBe(fixture.sharedAssignmentId);
  });

  test('keeps provable issue codes on lazy client-device search results', async () => {
    const fixture = seedTopology();
    const incomplete = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=litebeam'
    })).json().results.find((item: { node: { assignmentId?: number } }) => (
      item.node.assignmentId === fixture.incompleteAssignmentId
    ));
    const inactive = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=sn-legacy'
    })).json().results.find((item: { node: { assignmentId?: number } }) => (
      item.node.assignmentId === fixture.inactiveAssignmentId
    ));

    expect(incomplete.node.issueCodes).toEqual(['missing_ip', 'incomplete_configuration']);
    expect(inactive.node.issueCodes).toEqual(['inactive']);
  });

  /**
   * Sem IP só é falta em quem tem de ter um. O router do cliente anda em DHCP por
   * decisão de quem instalou, e acusá-lo enchia o mapa de avisos sobre nada — o
   * CPE ao lado, esse, continua a acusar.
   */
  test('does not flag a missing IP on equipment that is allowed to use DHCP', async () => {
    const fixture = seedTopology();
    const { serviceId } = db.prepare(
      'SELECT service_id AS serviceId FROM service_device_assignments WHERE id = ?'
    ).get(fixture.incompleteAssignmentId) as { serviceId: number };
    const attentionBefore = (await app.inject({ method: 'GET', url: '/api/topology' }))
      .json().stats.assignmentAttentionCount as number;
    const routerAssignmentId = insertAssignment({
      serviceId,
      catalogId: insertCatalog({ model: 'hAP ax lite', type: 'router' }),
      serial: 'SN-DHCP-ROUTER'
    });

    const results = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=sn-dhcp-router'
    })).json().results as Array<{ node: { assignmentId?: number; issueCodes: string[] } }>;
    const router = results.find((item) => item.node.assignmentId === routerAssignmentId);

    expect(router).toBeDefined();
    expect(router?.node.issueCodes).toEqual([]);

    // O total de atenções sai de um SQL à parte: se discordar dos nós, o mapa
    // anuncia problemas que nenhum equipamento mostra.
    const stats = (await app.inject({ method: 'GET', url: '/api/topology' })).json().stats;
    expect(stats.assignmentAttentionCount).toBe(attentionBefore);
  });

  test('caps results at the requested limit and never above 50', async () => {
    const fixture = seedTopology();
    for (let index = 0; index < 55; index += 1) {
      insertAssignment({
        serviceId: Number(db.prepare('SELECT id FROM services LIMIT 1').pluck().get()),
        catalogId: fixture.clientCatalogId,
        serial: `MATCH-${index}`,
        ip: `172.16.0.${index + 1}`
      });
    }
    const limited = await app.inject({ method: 'GET', url: '/api/topology/search?q=match&limit=7' });
    const capped = await app.inject({ method: 'GET', url: '/api/topology/search?q=match' });
    expect(limited.json().results).toHaveLength(7);
    expect(capped.json().results).toHaveLength(50);
  });

  test.each([
    '/api/topology/search',
    '/api/topology/search?q=x',
    `/api/topology/search?q=${'x'.repeat(121)}`,
    '/api/topology/search?q=valid&limit=0',
    '/api/topology/search?q=valid&limit=51',
    '/api/topology/search?q=valid&administrativeState=unknown',
    '/api/topology/search?q=valid&attention=maybe',
    '/api/topology/search?q=valid&island=',
    '/api/topology/search?q=valid&zone=',
    '/api/topology/search?q=valid&unsupported=value'
  ])('isolates invalid search parameters for %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
  });
});
