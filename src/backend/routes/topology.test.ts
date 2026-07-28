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
  backboneId: number;
  inactiveBackboneId: number;
  clientCatalogId: number;
  sharedAssignmentId: number;
  incompleteAssignmentId: number;
  inactiveAssignmentId: number;
};

const TABLES_TO_CLEAR = [
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

function seedTopology(): Fixture {
  const backboneId = insertCatalog({ model: 'Rocket Prism 5AC', type: 'antena', backboneQty: 2 });
  const inactiveBackboneId = insertCatalog({
    model: 'Core Switch Legacy',
    type: 'switch',
    backboneQty: 1,
    active: 0,
    serialized: 0
  });
  const clientCatalogId = insertCatalog({ model: 'LiteBeam 5AC', type: 'cpe', backboneQty: 0 });
  const inactiveClientCatalogId = insertCatalog({
    model: 'NanoStation Legacy',
    type: 'cpe',
    backboneQty: 0,
    active: 0,
    serialized: 0
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
    catalogId: backboneId,
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
  insertAssignment({
    serviceId: joseServiceId,
    catalogId: backboneId,
    serial: 'SN-ENDED',
    ip: '10.20.30.99',
    ended: true
  });
  return {
    backboneId,
    inactiveBackboneId,
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
      mappedAssignmentCount: 1,
      unmappedAssignmentCount: 2,
      clientCount: 3,
      serviceCount: 3,
      attentionCount: 4
    });
    expect(body.backbones).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `backbone:${fixture.backboneId}`,
        kind: 'backbone',
        catalogId: fixture.backboneId,
        relationship: 'inventory_lineage',
        backboneQty: 2,
        issueCodes: []
      }),
      expect.objectContaining({
        id: `backbone:${fixture.inactiveBackboneId}`,
        administrativeState: 'inactive',
        issueCodes: ['inactive']
      })
    ]));
    expect(body.edges).toHaveLength(2);
    expect(body.edges).toEqual(expect.arrayContaining([
      {
        id: `core-link:root:isp:backbone:${fixture.backboneId}`,
        kind: 'core-link',
        source: 'root:isp',
        target: `backbone:${fixture.backboneId}`,
        relationship: 'inventory_lineage'
      },
      {
        id: `core-link:root:isp:backbone:${fixture.inactiveBackboneId}`,
        kind: 'core-link',
        source: 'root:isp',
        target: `backbone:${fixture.inactiveBackboneId}`,
        relationship: 'inventory_lineage'
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
    const { backboneId, sharedAssignmentId } = seedTopology();
    const response = await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${backboneId}/clients`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.backbone).toMatchObject({ id: `backbone:${backboneId}`, catalogId: backboneId });
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
      parentId: `backbone:${backboneId}`,
      relationship: 'inventory_lineage',
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
      id: `client-link:backbone:${backboneId}:assignment:${sharedAssignmentId}`,
      kind: 'client-link',
      source: `backbone:${backboneId}`,
      target: `assignment:${sharedAssignmentId}`,
      relationship: 'inventory_lineage'
    }]);
    expect(body).not.toHaveProperty('clients');
  });

  test('excludes ended devices and returns an empty branch without inventing links', async () => {
    const { inactiveBackboneId } = seedTopology();
    const body = (await app.inject({
      method: 'GET',
      url: `/api/topology/backbones/${inactiveBackboneId}/clients`
    })).json();

    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.stats).toEqual({
      assignmentCount: 0,
      clientCount: 0,
      serviceCount: 0,
      attentionCount: 0
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

  test('treats a catalog row without backbone quantity as a missing backbone', async () => {
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

  test('returns ancestor metadata without claiming network reachability', async () => {
    const { backboneId, sharedAssignmentId } = seedTopology();
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
        id: `backbone:${backboneId}`,
        kind: 'backbone',
        label: 'Ubiquiti Rocket Prism 5AC',
        relationship: 'inventory_lineage'
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
