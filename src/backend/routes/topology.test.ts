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
  backboneQty: number;
  active?: number;
  serialized?: number;
}) {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog (
      category, type, brand, model, backbone_qty, active, is_serialized, stock_total
    ) VALUES ('equipamento', ?, 'Ubiquiti', ?, ?, ?, ?, 10)
  `).run(
    values.type,
    values.model,
    values.backboneQty,
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
  return values.id;
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
    type: 'antena',
    backboneQty: 0
  });
  const provisionalBackboneCatalogId = insertCatalog({
    model: 'Core Switch Legacy',
    type: 'switch',
    backboneQty: 0,
    serialized: 0
  });
  const clientCatalogId = insertCatalog({
    model: 'LiteBeam 5AC',
    type: 'cpe',
    backboneQty: 9
  });
  const inactiveClientCatalogId = insertCatalog({
    model: 'NanoStation Legacy',
    type: 'cpe',
    backboneQty: 0,
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
      label: 'Internet / Core ISPM',
      administrativeState: 'active',
      issueCodes: []
    });
    expect(body.stats).toEqual({
      backboneCount: 2,
      assignmentCount: 3,
      mappedAssignmentCount: 2,
      unmappedAssignmentCount: 1,
      clientCount: 3,
      serviceCount: 3,
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
        backboneQty: 1,
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
    }]);
    expect(body).not.toHaveProperty('clients');
  });

  test('excludes ended assignments even when their explicit link is still active', async () => {
    const { provisionalBackboneDeviceId, inactiveAssignmentId } = seedTopology();
    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${provisionalBackboneDeviceId}/clients`
    })).json();

    expect(body.nodes.map((node: { assignmentId: number }) => node.assignmentId))
      .toEqual([inactiveAssignmentId]);
    expect(body.edges).toHaveLength(1);
    expect(body.stats).toEqual({
      assignmentCount: 1,
      clientCount: 1,
      serviceCount: 1,
      attentionCount: 1
    });
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

  test('treats a catalog id as a missing backbone even when its legacy quantity is positive', async () => {
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
      { id: 'root:isp', kind: 'logical-root', label: 'Internet / Core ISPM' },
      {
        id: `backbone:${backboneDeviceId}`,
        kind: 'backbone',
        label: 'Monte Verde Principal',
        relationship: 'defined_link'
      }
    ]);
  });

  test('keeps CPE without a factual backbone lineage attached only to the logical root', async () => {
    const fixture = seedTopology();
    const body = (await app.inject({
      method: 'GET',
      url: '/api/topology/search?q=litebeam'
    })).json();
    const result = body.results.find((item: { node: { assignmentId?: number } }) => (
      item.node.assignmentId === fixture.incompleteAssignmentId
    ));

    expect(result.node).toMatchObject({
      id: `assignment:${fixture.incompleteAssignmentId}`,
      kind: 'client-device',
      parentId: 'root:isp'
    });
    expect(result.node).not.toHaveProperty('relationship');
    expect(result.ancestors).toEqual([
      { id: 'root:isp', kind: 'logical-root', label: 'Internet / Core ISPM' }
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
