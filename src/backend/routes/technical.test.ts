import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-tech-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.exec(`
    DELETE FROM whatsapp_notices;
    DELETE FROM backbone_assignment_links;
    DELETE FROM backbone_devices;
    DELETE FROM service_device_shares;
    DELETE FROM service_events;
    DELETE FROM service_install_costs;
    DELETE FROM service_material_lines;
    DELETE FROM service_device_assignments;
    DELETE FROM client_credits;
    DELETE FROM payment_receipts;
    DELETE FROM payments;
    DELETE FROM stock_movements;
    DELETE FROM services;
    DELETE FROM internet_plans;
    DELETE FROM equipment_catalog;
    DELETE FROM app_settings;
    DELETE FROM clients;
    DELETE FROM users;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

function seedBaseService() {
  const client = db.prepare(`
    INSERT INTO clients (client_code, full_name, status)
    VALUES ('CLT-T001', 'Cliente Tec', 'active')
  `).run();
  const plan = db.prepare(`
    INSERT INTO internet_plans (
      name, download_speed, upload_speed, connection_type, monthly_price_cve
    )
    VALUES ('Plano Tec', '50 Mbps', '20 Mbps', 'fibra', 3500)
  `).run();
  const catalog = db.prepare(`
    INSERT INTO equipment_catalog (
      type, brand, model, purchase_price_cve, selling_price_cve, stock_total, active
    )
    VALUES ('router', 'Teste', 'Router Tec', 1000, 1500, 10, 1)
  `).run();
  const user = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, active)
    VALUES ('tec1', 'hash', 'technician', 'Tecnico 1', 1)
  `).run();
  const service = db.prepare(`
    INSERT INTO services (
      client_id, plan_id, monthly_value_cve, activation_date, due_day, status
    )
    VALUES (?, ?, 3500, '2026-01-15', 10, 'active')
  `).run(client.lastInsertRowid, plan.lastInsertRowid);

  return { client, plan, catalog, user, service };
}

describe('technical routes', () => {
  test('creates a device assignment and records the installation event', async () => {
    const { catalog, service, user } = seedBaseService();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-001',
          assetTag: 'AST-001',
          ipAddress: '192.168.1.10',
          macAddress: 'AA:BB:CC:DD:EE:FF',
          technicianId: user.lastInsertRowid,
          notes: 'Instalacao inicial'
        }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      assignmentIds: [expect.any(Number)],
      eventId: expect.any(Number)
    });

    const history = await app.inject({
      method: 'GET',
      url: `/api/services/${service.lastInsertRowid}/technical-history`
    });

    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      assignments: Array<{ serialNumber: string; assetTag: string; endDate: string | null }>;
      events: Array<{ eventType: string; notes: string | null }>;
    };
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({
      serialNumber: 'SN-001',
      assetTag: 'AST-001',
      endDate: null
    });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      eventType: 'instalacao',
      notes: 'Instalou 1 equipamento(s) e 0 material(is)'
    });

    expect(db.prepare('SELECT stock_total AS stockTotal FROM equipment_catalog WHERE id = ?')
      .get(catalog.lastInsertRowid)).toEqual({ stockTotal: 9 });
    expect(db.prepare(`
      SELECT type, quantity, unit_cost_cve AS unitCostCve, service_id AS serviceId, client_name AS clientName
      FROM stock_movements
      WHERE catalog_id = ?
    `).get(catalog.lastInsertRowid)).toEqual({
      type: 'saida',
      quantity: 1,
      unitCostCve: 1000,
      serviceId: service.lastInsertRowid,
      clientName: 'Cliente Tec'
    });
  });

  test('replaces an active assignment in one transaction', async () => {
    const { catalog, service, user } = seedBaseService();
    const first = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-OLD',
          assetTag: 'AST-OLD',
          technicianId: user.lastInsertRowid,
          notes: 'Primeira instalacao'
        }]
      }
    });

    const assignmentId = (first.json() as { assignmentIds: number[] }).assignmentIds[0];
    const backboneDeviceId = db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name)
      VALUES (?, 'Backbone da atribuicao antiga')
    `).run(catalog.lastInsertRowid).lastInsertRowid;
    db.prepare(`
      INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id, created_by)
      VALUES (?, ?, ?)
    `).run(backboneDeviceId, assignmentId, user.lastInsertRowid);

    const replacement = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/replace`,
      payload: {
        catalogId: catalog.lastInsertRowid,
        serialNumber: 'SN-NEW',
        assetTag: 'AST-NEW',
        technicianId: user.lastInsertRowid,
        notes: 'Troca por avaria'
      }
    });

    expect(replacement.statusCode).toBe(201);
    expect(replacement.json()).toMatchObject({
      assignmentId: expect.any(Number),
      eventId: expect.any(Number)
    });

    const assignments = db.prepare(`
      SELECT serial_number AS serialNumber, asset_tag AS assetTag, end_date AS endDate
      FROM service_device_assignments
      WHERE service_id = ?
      ORDER BY id
    `).all(service.lastInsertRowid) as Array<{ serialNumber: string; assetTag: string; endDate: string | null }>;

    expect(assignments).toHaveLength(2);
    expect(assignments[0].endDate).not.toBeNull();
    expect(assignments[1]).toMatchObject({
      serialNumber: 'SN-NEW',
      assetTag: 'AST-NEW',
      endDate: null
    });
    expect(db.prepare(`
      SELECT
        ended_at AS endedAt,
        ended_by AS endedBy,
        change_reason AS changeReason
      FROM backbone_assignment_links
      WHERE assignment_id = ?
    `).get(assignmentId)).toMatchObject({
      endedAt: expect.any(String),
      endedBy: user.lastInsertRowid,
      changeReason: 'assignment_closed'
    });

    const events = db.prepare(`
      SELECT event_type AS eventType, notes
      FROM service_events
      WHERE service_id = ?
      ORDER BY id
    `).all(service.lastInsertRowid) as Array<{ eventType: string; notes: string | null }>;

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      eventType: 'troca_equipamento',
      notes: 'Troca por avaria'
    });
  });

  test('returns an active assignment and restores stock', async () => {
    const { catalog, service, user } = seedBaseService();
    const install = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-RET',
          technicianId: user.lastInsertRowid,
          notes: 'Instalacao inicial'
        }]
      }
    });
    const assignmentId = (install.json() as { assignmentIds: number[] }).assignmentIds[0];
    const backboneDeviceId = db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name)
      VALUES (?, 'Backbone da atribuicao devolvida')
    `).run(catalog.lastInsertRowid).lastInsertRowid;
    db.prepare(`
      INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id, created_by)
      VALUES (?, ?, ?)
    `).run(backboneDeviceId, assignmentId, user.lastInsertRowid);

    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?')
      .get(catalog.lastInsertRowid)).toEqual({ s: 9 });

    const result = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/return`,
      payload: { notes: 'Cliente cancelou', technicianId: user.lastInsertRowid }
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      assignmentId,
      eventId: expect.any(Number)
    });

    expect(db.prepare('SELECT end_date AS endDate FROM service_device_assignments WHERE id = ?')
      .get(assignmentId)).not.toEqual({ endDate: null });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?')
      .get(catalog.lastInsertRowid)).toEqual({ s: 10 });
    expect(db.prepare(`
      SELECT
        ended_at AS endedAt,
        ended_by AS endedBy,
        change_reason AS changeReason
      FROM backbone_assignment_links
      WHERE assignment_id = ?
    `).get(assignmentId)).toMatchObject({
      endedAt: expect.any(String),
      endedBy: user.lastInsertRowid,
      changeReason: 'assignment_closed'
    });

    expect(db.prepare(`
      SELECT type, quantity FROM stock_movements
      WHERE catalog_id = ? AND type = 'devolucao'
    `).get(catalog.lastInsertRowid)).toEqual({ type: 'devolucao', quantity: 1 });

    const events = db.prepare(`
      SELECT event_type AS eventType, notes FROM service_events
      WHERE service_id = ? ORDER BY id
    `).all(service.lastInsertRowid) as Array<{ eventType: string; notes: string | null }>;
    expect(events[events.length - 1]).toMatchObject({
      eventType: 'alteracao_servico',
      notes: 'Cliente cancelou'
    });
  });

  test('rejects returning an already closed assignment', async () => {
    const { catalog, service } = seedBaseService();
    const install = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [{ catalogId: catalog.lastInsertRowid, serialNumber: 'SN-X' }] }
    });
    const assignmentId = (install.json() as { assignmentIds: number[] }).assignmentIds[0];

    const first = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/return`,
      payload: {}
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/return`,
      payload: {}
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual({ error: 'Atribuicao ja encerrada' });
  });

  test('devolucao em lote fecha o servico e repoe so o que voltou inteiro', async () => {
    const { catalog, service } = seedBaseService();
    const serviceId = Number(service.lastInsertRowid);
    const catalogId = Number(catalog.lastInsertRowid);
    const cabo = db.prepare(`
      INSERT INTO equipment_catalog (type, brand, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('cabo', 'Teste', 'Cabo Tec', 'm', 0, 100, 200, 1)
    `).run();
    const caboId = Number(cabo.lastInsertRowid);

    const install = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/items`,
      payload: {
        items: [
          { catalogId, serialNumber: 'SN-A' },
          { catalogId, serialNumber: 'SN-B' },
          { catalogId: caboId, quantity: 50 }
        ]
      }
    });
    expect(install.statusCode).toBe(201);
    const stockAfterInstall = db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?')
      .get(catalogId) as { s: number };
    expect(stockAfterInstall.s).toBe(8);

    const assignments = db.prepare(`
      SELECT id FROM service_device_assignments WHERE service_id = ? ORDER BY id
    `).all(serviceId) as Array<{ id: number }>;

    const result = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/returns`,
      payload: {
        devices: [
          { assignmentId: assignments[0].id, condition: 'bom' },
          { assignmentId: assignments[1].id, condition: 'nao_devolvido' }
        ],
        materials: [{ catalogId: caboId, quantity: 30 }]
      }
    });

    expect(result.statusCode).toBe(200);
    const stock = db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?')
      .get(catalogId) as { s: number };
    expect(stock.s).toBe(9);
    const caboStock = db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?')
      .get(caboId) as { s: number };
    expect(caboStock.s).toBe(180);
    const open = db.prepare(`
      SELECT COUNT(*) AS total FROM service_device_assignments WHERE service_id = ? AND end_date IS NULL
    `).get(serviceId) as { total: number };
    expect(open.total).toBe(0);
  });

  test('devolucao em lote vazia e recusada', async () => {
    const { service } = seedBaseService();
    const result = await app.inject({
      method: 'POST',
      url: `/api/services/${Number(service.lastInsertRowid)}/returns`,
      payload: { devices: [], materials: [] }
    });
    expect(result.statusCode).toBe(400);
  });

  test('returns 404 when returning an unknown assignment', async () => {
    seedBaseService();
    const result = await app.inject({
      method: 'POST',
      url: '/api/service-device-assignments/99999/return',
      payload: {}
    });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({ error: 'Atribuicao nao encontrada' });
  });

  test('rejects duplicate active serial numbers', async () => {
    const { catalog, service } = seedBaseService();
    const first = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-DUP'
        }]
      }
    });

    expect(first.statusCode).toBe(201);

    const clientId = (db.prepare('SELECT id FROM clients LIMIT 1').get() as { id: number }).id;
    const planId = (db.prepare('SELECT id FROM internet_plans LIMIT 1').get() as { id: number }).id;
    const secondService = db.prepare(`
      INSERT INTO services (client_id, plan_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, ?, 3500, '2026-01-15', 10, 'active')
    `).run(clientId, planId);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/services/${secondService.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-DUP'
        }]
      }
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'Serial ja esta atribuido a outro equipamento ativo' });
  });

  test('rejects assignment when stock is not available', async () => {
    const { catalog, service } = seedBaseService();
    db.prepare('UPDATE equipment_catalog SET stock_total = 0 WHERE id = ?').run(catalog.lastInsertRowid);

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [{
          catalogId: catalog.lastInsertRowid,
          serialNumber: 'SN-NOSTOCK'
        }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 0' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_device_assignments').get()).toEqual({ n: 0 });
  });

  test('installs a batch of items (device + material) on an existing service', async () => {
    const { catalog, service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','UTP','metro',0,80,100,1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [
          { catalogId: catalog.lastInsertRowid, serialNumber: 'SN-B1' },
          { catalogId: cable.lastInsertRowid, quantity: 25 }
        ]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { assignmentIds: number[]; materialLineIds: number[]; eventId: number };
    expect(body.assignmentIds).toHaveLength(1);
    expect(body.materialLineIds).toHaveLength(1);
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(catalog.lastInsertRowid)).toEqual({ s: 9 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 75 });
    expect(db.prepare("SELECT count(*) AS n FROM service_events WHERE service_id = ? AND event_type='instalacao'").get(service.lastInsertRowid)).toEqual({ n: 1 });
  });

  test('rejects the batch when material stock is insufficient (no side effects)', async () => {
    const { service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total, active)
      VALUES ('material','cabo','UTP','metro',0,5,1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [{ catalogId: cable.lastInsertRowid, quantity: 10 }] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 5' });
    expect(db.prepare('SELECT count(*) AS n FROM service_material_lines').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 5 });
  });

  test('technical-history returns materials alongside assignments', async () => {
    const { service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','Cabo UTP','metro',0,80,100,1)
    `).run();
    await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [{ catalogId: cable.lastInsertRowid, quantity: 20 }] }
    });

    const history = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    const body = history.json() as { materials: Array<{ model: string; quantity: number; unitOfMeasure: string }> };
    expect(body.materials).toHaveLength(1);
    expect(body.materials[0]).toMatchObject({ model: 'Cabo UTP', quantity: 20, unitOfMeasure: 'metro' });
  });

  test('adds installation labour cost via /items (no items needed)', async () => {
    const { service } = seedBaseService();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { installCosts: [{ kind: 'mao_de_obra', amountCve: 1800 }] }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { installCostIds: number[] };
    expect(body.installCostIds).toHaveLength(1);

    const history = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    const hist = history.json() as { installCosts: Array<{ kind: string; amountCve: number }> };
    expect(hist.installCosts).toHaveLength(1);
    expect(hist.installCosts[0]).toMatchObject({ kind: 'mao_de_obra', amountCve: 1800 });
  });
});

describe('device identity (IP fixo)', () => {
  /** Instala um equipamento e devolve o id da atribuicao criada. */
  async function install(serviceId: unknown, catalogId: unknown, fields: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/items`,
      payload: { items: [{ catalogId, ...fields }] }
    });
    return { response, assignmentId: response.statusCode === 201 ? (response.json() as { assignmentIds: number[] }).assignmentIds[0] : null };
  }

  function counts(catalogId: unknown) {
    return {
      stock: (db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(catalogId) as { n: number }).n,
      movements: (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n,
      events: (db.prepare('SELECT COUNT(*) AS n FROM service_events').get() as { n: number }).n
    };
  }

  test('a auditoria guarda o MAC anterior, nao so o novo', async () => {
    // A descoberta passou a escrever MAC. Sem o anterior no rasto, uma troca de
    // equipamento no terreno fica indistinguivel de um preenchimento.
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, {
      serialNumber: 'SN-MAC', ipAddress: '192.168.1.30', macAddress: 'AA:BB:CC:DD:EE:10'
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}`,
      payload: { macAddress: 'AA:BB:CC:DD:EE:11' }
    });
    expect(response.statusCode).toBe(200);

    const audit = db.prepare(
      `SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'update_device' ORDER BY id DESC LIMIT 1`
    ).get() as { metadata: string };
    expect(JSON.parse(audit.metadata)).toMatchObject({
      macAddress: 'AA:BB:CC:DD:EE:11',
      previousMacAddress: 'AA:BB:CC:DD:EE:10'
    });
  });

  test('patch updates identification in place without touching stock', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, {
      serialNumber: 'SN-100', ipAddress: '192.168.1.10', macAddress: 'AA:BB:CC:DD:EE:01'
    });
    const before = counts(catalog.lastInsertRowid);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}`,
      payload: { ipAddress: '192.168.1.11', macAddress: 'AA:BB:CC:DD:EE:02', notes: 'IP corrigido' }
    });

    expect(response.statusCode).toBe(200);

    const history = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    const body = history.json() as { assignments: Array<{ id: number; ipAddress: string; macAddress: string; serialNumber: string; notes: string; endDate: string | null }> };
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({
      id: assignmentId,
      ipAddress: '192.168.1.11',
      macAddress: 'AA:BB:CC:DD:EE:02',
      serialNumber: 'SN-100',
      notes: 'IP corrigido',
      endDate: null
    });
    expect(counts(catalog.lastInsertRowid)).toEqual(before);
  });

  test('patch corrige o aluguer do equipamento instalado', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid);
    db.prepare('UPDATE service_device_assignments SET rental_fee_cve = 500 WHERE id = ?').run(assignmentId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}`,
      payload: { rentalFeeCve: 250 }
    });

    expect(response.statusCode).toBe(200);
    expect(db.prepare('SELECT rental_fee_cve AS r FROM service_device_assignments WHERE id = ?').get(assignmentId))
      .toEqual({ r: 250 });
    // O aluguer entra no que o cliente paga: o antes e o depois ficam escritos.
    const audit = db.prepare(`SELECT metadata_json AS m FROM audit_logs WHERE action='update_device' ORDER BY id DESC LIMIT 1`).get() as { m: string };
    expect(JSON.parse(audit.m)).toMatchObject({ rentalFeeCve: 250, previousRentalFeeCve: 500 });
  });

  test('um patch sem aluguer não lhe mexe', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid);
    db.prepare('UPDATE service_device_assignments SET rental_fee_cve = 250 WHERE id = ?').run(assignmentId);

    await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}`,
      payload: { notes: 'só uma nota' }
    });

    expect(db.prepare('SELECT rental_fee_cve AS r FROM service_device_assignments WHERE id = ?').get(assignmentId))
      .toEqual({ r: 250 });
  });

  test('equipamento do cliente não consome stock, nem ao instalar nem ao devolver', async () => {
    const { catalog, service } = seedBaseService();
    const stockBefore = (db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?')
      .get(catalog.lastInsertRowid) as { n: number }).n;
    const movementsBefore = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;

    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ownership: 'cliente' });

    // Nunca esteve no armazém: comprou-o o cliente, ou herdou-o da operadora anterior.
    expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(catalog.lastInsertRowid))
      .toEqual({ n: stockBefore });
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get()).toEqual({ n: movementsBefore });

    const returned = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/return`,
      payload: { condition: 'bom' }
    });

    expect(returned.statusCode).toBe(200);
    expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(catalog.lastInsertRowid))
      .toEqual({ n: stockBefore });
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get()).toEqual({ n: movementsBefore });
  });

  test('equipamento do cliente regista-se com o artigo a zero', async () => {
    const { catalog, service } = seedBaseService();
    // O caso real: o modelo existe no catálogo só para dar nome ao que está em casa
    // do cliente, e a empresa não tem nenhuma unidade dele no armazém.
    db.prepare('UPDATE equipment_catalog SET stock_total = 0 WHERE id = ?').run(catalog.lastInsertRowid);

    const recusado = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [{ catalogId: catalog.lastInsertRowid }] }
    });
    expect(recusado.statusCode).toBe(400);
    expect((recusado.json() as { error: string }).error).toContain('Stock insuficiente');

    const aceite = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [{ catalogId: catalog.lastInsertRowid, ownership: 'cliente' }] }
    });
    expect(aceite.statusCode).toBe(201);
    expect(db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(catalog.lastInsertRowid))
      .toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT ownership, rental_fee_cve AS renda FROM service_device_assignments WHERE service_id = ?
    `).get(service.lastInsertRowid)).toEqual({ ownership: 'cliente', renda: 0 });
  });

  test('equipamento do cliente não aceita aluguer', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ownership: 'cliente' });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}`,
      payload: { rentalFeeCve: 250 }
    });

    expect(response.statusCode).toBe(400);
    expect(db.prepare('SELECT rental_fee_cve AS r FROM service_device_assignments WHERE id = ?').get(assignmentId))
      .toEqual({ r: 0 });
  });

  test('patch rejects a malformed IPv4 and leaves the row untouched', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}`,
      payload: { ipAddress: '192.168.1.999' }
    });

    expect(response.statusCode).toBe(400);
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(assignmentId))
      .toEqual({ ip: '192.168.1.10' });
  });

  test('patch rejects an IP owned by another active assignment', async () => {
    const { catalog, service } = seedBaseService();
    await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });
    const second = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.20' });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${second.assignmentId}`,
      payload: { ipAddress: '192.168.1.10' }
    });

    expect(response.statusCode).toBe(409);
  });

  test('patch allows editing another field when the row already carries a legacy duplicate IP', async () => {
    const { catalog, service } = seedBaseService();
    // Dados legados: sem indice unico, a BD real pode ja ter IPs repetidos.
    const insert = db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id, ip_address, start_date)
      VALUES (?, ?, '192.168.1.30', date('now'))
    `);
    insert.run(service.lastInsertRowid, catalog.lastInsertRowid);
    const legacy = insert.run(service.lastInsertRowid, catalog.lastInsertRowid);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${legacy.lastInsertRowid}`,
      payload: { ipAddress: '192.168.1.30', macAddress: 'AA:BB:CC:DD:EE:09' }
    });

    expect(response.statusCode).toBe(200);
  });

  test('patch rejects a closed assignment', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });
    await app.inject({ method: 'POST', url: `/api/service-device-assignments/${assignmentId}/return`, payload: {} });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}`,
      payload: { ipAddress: '192.168.1.11' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Atribuicao ja encerrada' });
  });

  test('patch returns 404 for an unknown assignment', async () => {
    seedBaseService();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments/9999',
      payload: { ipAddress: '192.168.1.11' }
    });
    expect(response.statusCode).toBe(404);
  });

  test('install rejects an IP already used by an active assignment', async () => {
    const { catalog, service } = seedBaseService();
    await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });

    const { response } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });

    expect(response.statusCode).toBe(409);
  });

  test('install rejects a malformed IPv4', async () => {
    const { catalog, service } = seedBaseService();
    const { response } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1' });
    expect(response.statusCode).toBe(400);
  });

  /**
   * O MAC passou a valer como identidade — dois equipamentos ativos com o mesmo
   * MAC é sempre erro de registo, e guardá-lo em formatos diferentes escondia-o.
   */
  test('install canonicalizes the MAC and refuses a repeated one', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, {
      macAddress: '9c-47-82-30-34-9b'
    });

    expect(db.prepare('SELECT mac_address AS mac FROM service_device_assignments WHERE id = ?').get(assignmentId))
      .toEqual({ mac: '9C:47:82:30:34:9B' });

    // O mesmo equipamento, escrito de outra maneira, continua a ser o mesmo.
    const { response } = await install(service.lastInsertRowid, catalog.lastInsertRowid, {
      macAddress: '9C:47:82:30:34:9B'
    });
    expect(response.statusCode).toBe(409);
  });

  test('install rejects a malformed MAC', async () => {
    const { catalog, service } = seedBaseService();
    const { response } = await install(service.lastInsertRowid, catalog.lastInsertRowid, {
      macAddress: '9C:47:82:30:34'
    });
    expect(response.statusCode).toBe(400);
  });

  test('install rejects two items in the same batch sharing an IP', async () => {
    const { catalog, service } = seedBaseService();
    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [
          { catalogId: catalog.lastInsertRowid, ipAddress: '192.168.1.40' },
          { catalogId: catalog.lastInsertRowid, ipAddress: '192.168.1.40' }
        ]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_device_assignments').get()).toEqual({ n: 0 });
  });

  test('an IP frees up after the device is returned', async () => {
    const { catalog, service } = seedBaseService();
    const { assignmentId } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });
    await app.inject({ method: 'POST', url: `/api/service-device-assignments/${assignmentId}/return`, payload: {} });

    const { response } = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });

    expect(response.statusCode).toBe(201);
  });

  /**
   * Quem leva endereco reservado decide-se na instalacao, nao pelo tipo: um
   * router de gestao tambem pode querer um, e se nao aparecer nesta lista nao ha
   * onde lho dar.
   */
  test('lists every active equipment, routers included, so any can take an IP', async () => {
    const { catalog, service } = seedBaseService();
    const antenna = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','cpe','TP-Link','CPE 510', 4000, 1, 5, 1)
    `).run();
    // seedBaseService() cria um catalogo type='router'.
    const router = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-ROUTER' });
    const cpe = await install(service.lastInsertRowid, antenna.lastInsertRowid, { serialNumber: 'SN-CPE' });

    const response = await app.inject({ method: 'GET', url: '/api/service-device-assignments' });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{ id: number; serialNumber: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id).sort()).toEqual([router.assignmentId, cpe.assignmentId].sort());
  });

  test('lists active assignments across services for bulk IP assignment', async () => {
    const { service } = seedBaseService();
    const catalog = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','antena','TP-Link','CPE710', 6000, 1, 10, 1)
    `).run();
    const kept = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A', ipAddress: '192.168.1.10' });
    const returned = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B' });
    await app.inject({ method: 'POST', url: `/api/service-device-assignments/${returned.assignmentId}/return`, payload: {} });

    const response = await app.inject({ method: 'GET', url: '/api/service-device-assignments' });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{ id: number; clientName: string; model: string; serialNumber: string | null; ipAddress: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: kept.assignmentId,
      clientName: 'Cliente Tec',
      model: 'CPE710',
      serialNumber: 'SN-A',
      ipAddress: '192.168.1.10'
    });
  });

  test('bulk assigns IPs to several devices at once', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A' });
    const b = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B' });
    const before = counts(catalog.lastInsertRowid);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, ipAddress: '192.168.1.11' }, { id: b.assignmentId, ipAddress: '192.168.1.12' }] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ updated: 2 });
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(a.assignmentId)).toEqual({ ip: '192.168.1.11' });
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(b.assignmentId)).toEqual({ ip: '192.168.1.12' });
    expect(counts(catalog.lastInsertRowid)).toEqual(before);
  });

  test('bulk swaps two IPs without tripping the duplicate guard', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A', ipAddress: '192.168.1.11' });
    const b = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B', ipAddress: '192.168.1.12' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, ipAddress: '192.168.1.12' }, { id: b.assignmentId, ipAddress: '192.168.1.11' }] }
    });

    expect(response.statusCode).toBe(200);
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(a.assignmentId)).toEqual({ ip: '192.168.1.12' });
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(b.assignmentId)).toEqual({ ip: '192.168.1.11' });
  });

  test('bulk writes nothing when one IP is malformed', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A' });
    const b = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, ipAddress: '192.168.1.11' }, { id: b.assignmentId, ipAddress: '192.168.1.X' }] }
    });

    expect(response.statusCode).toBe(400);
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(a.assignmentId)).toEqual({ ip: null });
  });

  test('bulk rejects the same IP twice in one payload', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A' });
    const b = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, ipAddress: '192.168.1.11' }, { id: b.assignmentId, ipAddress: '192.168.1.11' }] }
    });

    expect(response.statusCode).toBe(409);
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(a.assignmentId)).toEqual({ ip: null });
  });

  test('bulk rejects an IP already held by an assignment outside the payload', async () => {
    const { catalog, service } = seedBaseService();
    await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A', ipAddress: '192.168.1.50' });
    const b = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: b.assignmentId, ipAddress: '192.168.1.50' }] }
    });

    expect(response.statusCode).toBe(409);
  });

  test('bulk rejects a closed or unknown assignment', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A' });
    await app.inject({ method: 'POST', url: `/api/service-device-assignments/${a.assignmentId}/return`, payload: {} });

    const closed = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, ipAddress: '192.168.1.11' }] }
    });
    expect(closed.statusCode).toBe(404);

    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: 9999, ipAddress: '192.168.1.11' }] }
    });
    expect(unknown.statusCode).toBe(404);
  });

  test('bulk clears an IP when sent empty', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A', ipAddress: '192.168.1.11' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, ipAddress: '' }] }
    });

    expect(response.statusCode).toBe(200);
    expect(db.prepare('SELECT ip_address AS ip FROM service_device_assignments WHERE id = ?').get(a.assignmentId)).toEqual({ ip: null });
  });

  /**
   * O ecrã de identificação escreve as duas colunas de uma vez: é lá que se
   * apanham os equipamentos que estão no terreno sem identidade nenhuma.
   */
  test('bulk writes the MAC alongside the IP, canonicalized', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, ipAddress: '192.168.1.31', macAddress: '9c-47-82-30-34-9b' }] }
    });

    expect(response.statusCode).toBe(200);
    expect(db.prepare(
      'SELECT ip_address AS ip, mac_address AS mac FROM service_device_assignments WHERE id = ?'
    ).get(a.assignmentId)).toEqual({ ip: '192.168.1.31', mac: '9C:47:82:30:34:9B' });
  });

  test('bulk refuses a MAC that would end up on two active devices', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, {
      serialNumber: 'SN-A', macAddress: '9C:47:82:30:34:9B'
    });
    const b = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: b.assignmentId, macAddress: '9c:47:82:30:34:9b' }] }
    });

    expect(response.statusCode).toBe(409);
    expect(db.prepare('SELECT mac_address AS mac FROM service_device_assignments WHERE id = ?').get(b.assignmentId))
      .toEqual({ mac: null });
    expect(db.prepare('SELECT mac_address AS mac FROM service_device_assignments WHERE id = ?').get(a.assignmentId))
      .toEqual({ mac: '9C:47:82:30:34:9B' });
  });

  test('bulk writes nothing when one MAC is malformed', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-A' });
    const b = await install(service.lastInsertRowid, catalog.lastInsertRowid, { serialNumber: 'SN-B' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: {
        items: [
          { id: a.assignmentId, macAddress: '9C:47:82:30:34:9B' },
          { id: b.assignmentId, macAddress: 'bananeira' }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM service_device_assignments WHERE mac_address IS NOT NULL"
    ).get()).toEqual({ n: 0 });
  });

  /** Coluna ausente é coluna que não se mexe — o IP de quem já o tinha fica. */
  test('bulk leaves a field alone when the payload omits it', async () => {
    const { catalog, service } = seedBaseService();
    const a = await install(service.lastInsertRowid, catalog.lastInsertRowid, {
      serialNumber: 'SN-A', ipAddress: '192.168.1.44'
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/service-device-assignments',
      payload: { items: [{ id: a.assignmentId, macAddress: '9C:47:82:30:34:9B' }] }
    });

    expect(response.statusCode).toBe(200);
    expect(db.prepare(
      'SELECT ip_address AS ip, mac_address AS mac FROM service_device_assignments WHERE id = ?'
    ).get(a.assignmentId)).toEqual({ ip: '192.168.1.44', mac: '9C:47:82:30:34:9B' });
  });

  test('replace rejects an IP owned by another active assignment', async () => {
    const { catalog, service } = seedBaseService();
    await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.10' });
    const second = await install(service.lastInsertRowid, catalog.lastInsertRowid, { ipAddress: '192.168.1.20' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${second.assignmentId}/replace`,
      payload: { catalogId: catalog.lastInsertRowid, ipAddress: '192.168.1.10' }
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('antena partilhada', () => {
  /** Antena + dois servicos de clientes distintos: o cenario do predio com switch. */
  function seedTwoServices() {
    const base = seedBaseService();
    const antenna = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, shipping_cost_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','antena','TP-Link','CPE710', 2500, 500, 1, 5, 1)
    `).run();
    const client2 = db.prepare(`
      INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-T002', 'Vizinho Tec', 'active')
    `).run();
    const service2 = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, activation_date, due_day, status)
      VALUES (?, 3000, '2026-01-20', 10, 'active')
    `).run(client2.lastInsertRowid);
    return { ...base, antenna, client2, service2 };
  }

  async function installAntenna(serviceId: unknown, catalogId: unknown, fields: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/items`,
      payload: { items: [{ catalogId, ...fields }] }
    });
    return (response.json() as { assignmentIds: number[] }).assignmentIds[0];
  }

  function share(assignmentId: number, serviceId: unknown) {
    return app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/shares`,
      payload: { serviceId }
    });
  }

  function stockOf(catalogId: unknown) {
    return (db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(catalogId) as { n: number }).n;
  }

  test('sharing never moves stock', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid, { ipAddress: '192.168.1.10' });
    const stockBefore = stockOf(antenna.lastInsertRowid);
    const movementsBefore = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;
    const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM service_events').get() as { n: number }).n;

    const response = await share(assignmentId, service2.lastInsertRowid);

    expect(response.statusCode).toBe(201);
    expect(stockOf(antenna.lastInsertRowid)).toBe(stockBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get()).toEqual({ n: movementsBefore });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_events').get()).toEqual({ n: eventsBefore });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_device_assignments').get()).toEqual({ n: 1 });
  });

  test('the shared service sees the antenna and its IP', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid, { ipAddress: '192.168.1.10' });
    await share(assignmentId, service2.lastInsertRowid);

    const history = await app.inject({ method: 'GET', url: `/api/services/${service2.lastInsertRowid}/technical-history` });
    const body = history.json() as { assignments: Array<{ id: number; ipAddress: string; isOwner: number }> };

    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({ id: assignmentId, ipAddress: '192.168.1.10', isOwner: 0 });

    const ownerHistory = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    const owner = ownerHistory.json() as { assignments: Array<{ isOwner: number; shareCount: number; sharedWithNames: string | null }> };
    expect(owner.assignments[0]).toMatchObject({ isOwner: 1, shareCount: 1, sharedWithNames: 'Vizinho Tec' });
  });

  test('rejects duplicate, self, unknown and closed shares', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid);

    expect((await share(assignmentId, service.lastInsertRowid)).statusCode).toBe(409);
    expect((await share(assignmentId, service2.lastInsertRowid)).statusCode).toBe(201);
    expect((await share(assignmentId, service2.lastInsertRowid)).statusCode).toBe(409);
    expect((await share(assignmentId, 9999)).statusCode).toBe(404);
    expect((await share(9999, service2.lastInsertRowid)).statusCode).toBe(404);

    const closed = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid);
    await app.inject({ method: 'POST', url: `/api/service-device-assignments/${closed}/return`, payload: {} });
    expect((await share(closed, service2.lastInsertRowid)).statusCode).toBe(400);
  });

  test('promoting a sharer moves the antenna, its rental and the history', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid, { ipAddress: '192.168.1.10' });
    await share(assignmentId, service2.lastInsertRowid);
    const stockBefore = stockOf(antenna.lastInsertRowid);

    const promoted = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/owner`,
      payload: { serviceId: service2.lastInsertRowid }
    });

    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ toClientName: 'Vizinho Tec', keptPreviousAsShare: false });
    expect(stockOf(antenna.lastInsertRowid)).toBe(stockBefore);
    expect(db.prepare('SELECT service_id AS s FROM service_device_assignments WHERE id = ?').get(assignmentId))
      .toEqual({ s: service2.lastInsertRowid });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_device_shares').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'transfer_device_owner'").get())
      .toEqual({ n: 1 });

    // O antigo titular deixa de ver a antena; o novo passa a ser o titular dela.
    const previous = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    expect((previous.json() as { assignments: unknown[] }).assignments).toHaveLength(0);
    const current = await app.inject({ method: 'GET', url: `/api/services/${service2.lastInsertRowid}/technical-history` });
    expect((current.json() as { assignments: Array<{ isOwner: number }> }).assignments[0]).toMatchObject({ isOwner: 1 });

    // Sem partilhas por fechar, a devolucao ja passa.
    const returned = await app.inject({ method: 'POST', url: `/api/service-device-assignments/${assignmentId}/return`, payload: {} });
    expect(returned.statusCode).toBe(200);
  });

  test('promoting keeps the previous owner when asked, and refuses a stranger', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid);
    await share(assignmentId, service2.lastInsertRowid);

    const stranger = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/owner`,
      payload: { serviceId: 9999 }
    });
    expect(stranger.statusCode).toBe(404);

    const kept = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/owner`,
      payload: { serviceId: service2.lastInsertRowid, keepPreviousAsShare: true }
    });
    expect(kept.statusCode).toBe(200);

    const history = await app.inject({ method: 'GET', url: `/api/services/${service2.lastInsertRowid}/technical-history` });
    const rows = (history.json() as {
      assignments: Array<{ isOwner: number; shareCount: number; sharedWith: Array<{ serviceId: number; clientName: string }> }>;
    }).assignments;
    expect(rows[0]).toMatchObject({ isOwner: 1, shareCount: 1 });
    expect(rows[0].sharedWith).toEqual([{ serviceId: service.lastInsertRowid, clientName: 'Cliente Tec' }]);

    // Ja e o titular: promove-lo outra vez nao faz sentido.
    const again = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/owner`,
      payload: { serviceId: service2.lastInsertRowid }
    });
    expect(again.statusCode).toBe(409);
  });

  test('return is refused while another service depends on the antenna', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid);
    await share(assignmentId, service2.lastInsertRowid);
    const stockBefore = stockOf(antenna.lastInsertRowid);

    const refused = await app.inject({ method: 'POST', url: `/api/service-device-assignments/${assignmentId}/return`, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toContain('Vizinho Tec');
    expect(stockOf(antenna.lastInsertRowid)).toBe(stockBefore);

    const unshared = await app.inject({
      method: 'DELETE',
      url: `/api/service-device-assignments/${assignmentId}/shares/${service2.lastInsertRowid}`
    });
    expect(unshared.statusCode).toBe(200);

    const returned = await app.inject({ method: 'POST', url: `/api/service-device-assignments/${assignmentId}/return`, payload: {} });
    expect(returned.statusCode).toBe(200);
    expect(stockOf(antenna.lastInsertRowid)).toBe(stockBefore + 1);
  });

  // A troca de uma antena partilhada tem de passar apesar da guarda que recusa
  // devolver uma unidade com vizinhos: eles nao ficam sem sinal, a unidade nova
  // assume-os na mesma transacao.
  test('replace carries the shares over to the new unit and leaves stock level', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid);
    await share(assignmentId, service2.lastInsertRowid);
    const stockBefore = stockOf(antenna.lastInsertRowid);

    const response = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/replace`,
      payload: { catalogId: antenna.lastInsertRowid, ipAddress: '192.168.1.11' }
    });

    expect(response.statusCode).toBe(201);
    const replacementId = (response.json() as { assignmentId: number }).assignmentId;
    // Sai uma, entra outra: a retirada volta ao armazem por omissao.
    expect(stockOf(antenna.lastInsertRowid)).toBe(stockBefore);
    expect(db.prepare('SELECT assignment_id AS id FROM service_device_shares').all()).toEqual([{ id: replacementId }]);

    const history = await app.inject({ method: 'GET', url: `/api/services/${service2.lastInsertRowid}/technical-history` });
    const body = history.json() as { assignments: Array<{ id: number; ipAddress: string }> };
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({ id: replacementId, ipAddress: '192.168.1.11' });
  });

  test('the bulk IP list shows a shared antenna once, naming who else it serves', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid, { ipAddress: '192.168.1.10' });
    await share(assignmentId, service2.lastInsertRowid);

    const response = await app.inject({ method: 'GET', url: '/api/service-device-assignments' });
    const rows = response.json() as Array<{ id: number; clientName: string; sharedWithNames: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: assignmentId, clientName: 'Cliente Tec', sharedWithNames: 'Vizinho Tec' });
  });

  test('unshare requires an existing share', async () => {
    const { antenna, service, service2 } = seedTwoServices();
    const assignmentId = await installAntenna(service.lastInsertRowid, antenna.lastInsertRowid);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/service-device-assignments/${assignmentId}/shares/${service2.lastInsertRowid}`
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('troca de equipamento', () => {
  /** Modelo com renda: e a renda que a troca perdia ao escrever a atribuicao a mao. */
  function seedRentedDevice() {
    const base = seedBaseService();
    const catalog = db.prepare(`
      INSERT INTO equipment_catalog (
        category, type, brand, model, purchase_price_cve, is_serialized, stock_total, rental_fee_cve, active
      )
      VALUES ('equipamento','antena','TP-Link','CPE510', 3000, 1, 5, 250, 1)
    `).run();
    return { ...base, catalog };
  }

  async function install(serviceId: unknown, catalogId: unknown, fields: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/items`,
      payload: { items: [{ catalogId, ...fields }] }
    });
    return (response.json() as { assignmentIds: number[] }).assignmentIds[0];
  }

  function replace(assignmentId: number, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/replace`,
      payload
    });
  }

  const stockOf = (catalogId: unknown) =>
    (db.prepare('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?').get(catalogId) as { n: number }).n;

  const assignment = (id: unknown) => db.prepare(`
    SELECT ownership, rental_fee_cve AS rentalFeeCve, end_date AS endDate, return_condition AS returnCondition
    FROM service_device_assignments WHERE id = ?
  `).get(id) as { ownership: string; rentalFeeCve: number; endDate: string | null; returnCondition: string | null };

  test('a unidade nova mantem a renda e a propriedade do modelo', async () => {
    const { service, catalog } = seedRentedDevice();
    const original = await install(service.lastInsertRowid, catalog.lastInsertRowid);

    const response = await replace(original, { catalogId: catalog.lastInsertRowid, serialNumber: 'NOVA-1' });

    expect(response.statusCode).toBe(201);
    const replacementId = (response.json() as { assignmentId: number }).assignmentId;
    // A regressao que isto trava: o INSERT a mao omitia ownership e renda, e a
    // mensalidade do equipamento caia para zero na primeira substituicao.
    expect(assignment(replacementId)).toMatchObject({ ownership: 'isp', rentalFeeCve: 250, endDate: null });
  });

  test('por omissao a unidade retirada volta ao armazem', async () => {
    const { service, catalog } = seedRentedDevice();
    const original = await install(service.lastInsertRowid, catalog.lastInsertRowid);
    const antes = stockOf(catalog.lastInsertRowid);

    await replace(original, { catalogId: catalog.lastInsertRowid, serialNumber: 'NOVA-2' });

    expect(stockOf(catalog.lastInsertRowid)).toBe(antes);
    expect(assignment(original)).toMatchObject({ returnCondition: 'bom' });
    expect(assignment(original).endDate).not.toBeNull();
    expect(db.prepare(`
      SELECT type FROM stock_movements WHERE catalog_id = ? ORDER BY id
    `).all(catalog.lastInsertRowid)).toEqual([
      { type: 'saida' }, { type: 'devolucao' }, { type: 'saida' }
    ]);
  });

  test('a unidade avariada nao volta ao armazem, mas fica registada', async () => {
    const { service, catalog } = seedRentedDevice();
    const original = await install(service.lastInsertRowid, catalog.lastInsertRowid);
    const antes = stockOf(catalog.lastInsertRowid);

    await replace(original, {
      catalogId: catalog.lastInsertRowid, serialNumber: 'NOVA-3', returnCondition: 'avariado'
    });

    expect(stockOf(catalog.lastInsertRowid)).toBe(antes - 1);
    expect(assignment(original)).toMatchObject({ returnCondition: 'avariado' });
  });

  test('sem stock a troca e recusada e nada muda', async () => {
    const { service, catalog } = seedRentedDevice();
    const original = await install(service.lastInsertRowid, catalog.lastInsertRowid);
    // So o que esta na prateleira conta: a unidade a sair ainda esta no cliente.
    db.prepare('UPDATE equipment_catalog SET stock_total = 0 WHERE id = ?').run(catalog.lastInsertRowid);

    const response = await replace(original, { catalogId: catalog.lastInsertRowid, serialNumber: 'NOVA-4' });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('Stock insuficiente');
    expect(assignment(original).endDate).toBeNull();
    expect(stockOf(catalog.lastInsertRowid)).toBe(0);
  });

  test('a troca so grava um evento, o da troca', async () => {
    const { service, catalog } = seedRentedDevice();
    const original = await install(service.lastInsertRowid, catalog.lastInsertRowid);
    db.prepare('DELETE FROM service_events').run();

    await replace(original, { catalogId: catalog.lastInsertRowid, serialNumber: 'NOVA-5' });

    expect(db.prepare('SELECT event_type AS tipo FROM service_events').all())
      .toEqual([{ tipo: 'troca_equipamento' }]);
  });
});

describe('datas do ciclo de equipamento', () => {
  function seedDatedService() {
    const base = seedBaseService();
    const catalog = db.prepare(`
      INSERT INTO equipment_catalog (
        category, type, brand, model, purchase_price_cve, is_serialized, stock_total, rental_fee_cve, active
      )
      VALUES ('equipamento','antena','TP-Link','CPE510', 3000, 1, 5, 250, 1)
    `).run();
    const material = db.prepare(`
      INSERT INTO equipment_catalog (
        category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active
      )
      VALUES ('material','cabo','UTP','metro', 0, 100, 500, 1)
    `).run();
    // A instalacao nao pode ser anterior a ativacao: fixa-la torna o teste legivel.
    db.prepare("UPDATE services SET activation_date = '2026-01-10' WHERE id = ?").run(base.service.lastInsertRowid);
    return { ...base, catalog, material };
  }

  const items = (serviceId: unknown, payload: Record<string, unknown>[]) =>
    app.inject({ method: 'POST', url: `/api/services/${serviceId}/items`, payload: { items: payload } });

  const row = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, unknown>;

  test('a data do formulario fica na atribuicao, no razao e no evento', async () => {
    const { service, catalog } = seedDatedService();

    const response = await items(service.lastInsertRowid, [
      { catalogId: catalog.lastInsertRowid, installedOn: '2026-03-15' }
    ]);
    expect(response.statusCode).toBe(201);

    const assignmentId = (response.json() as { assignmentIds: number[] }).assignmentIds[0];
    expect(row('SELECT start_date AS d FROM service_device_assignments WHERE id = ?', assignmentId))
      .toEqual({ d: '2026-03-15' });
    // O razao guarda o dia do facto — senao o historico do artigo mentia.
    expect(row('SELECT date(created_at) AS d FROM stock_movements WHERE catalog_id = ? ORDER BY id DESC', catalog.lastInsertRowid))
      .toEqual({ d: '2026-03-15' });
    expect(row('SELECT date(created_at) AS d FROM service_events ORDER BY id DESC'))
      .toEqual({ d: '2026-03-15' });
  });

  test('o lancamento fica com hoje, mesmo quando o facto e antigo', async () => {
    const { service, catalog } = seedDatedService();
    const response = await items(service.lastInsertRowid, [
      { catalogId: catalog.lastInsertRowid, installedOn: '2026-03-15' }
    ]);
    const assignmentId = (response.json() as { assignmentIds: number[] }).assignmentIds[0];

    // Facto e lancamento sao coisas diferentes: a auditoria nao se perde.
    expect(row("SELECT date(created_at) = date('now') AS hoje FROM service_device_assignments WHERE id = ?", assignmentId))
      .toEqual({ hoje: 1 });
  });

  test('o material tambem leva a data do facto', async () => {
    const { service, material } = seedDatedService();
    await items(service.lastInsertRowid, [
      { catalogId: material.lastInsertRowid, quantity: 30, installedOn: '2026-02-01' }
    ]);

    expect(row('SELECT installed_on AS d FROM service_material_lines ORDER BY id DESC'))
      .toEqual({ d: '2026-02-01' });
  });

  test('sem data e hoje, como sempre foi', async () => {
    const { service, catalog } = seedDatedService();
    const response = await items(service.lastInsertRowid, [{ catalogId: catalog.lastInsertRowid }]);
    const assignmentId = (response.json() as { assignmentIds: number[] }).assignmentIds[0];

    expect(row("SELECT start_date = date('now') AS hoje FROM service_device_assignments WHERE id = ?", assignmentId))
      .toEqual({ hoje: 1 });
  });

  test('recusa instalar no futuro ou antes de o servico existir', async () => {
    const { service, catalog } = seedDatedService();

    const futura = await items(service.lastInsertRowid, [
      { catalogId: catalog.lastInsertRowid, installedOn: '2099-01-01' }
    ]);
    expect(futura.statusCode).toBe(400);
    expect((futura.json() as { error: string }).error).toContain('no futuro');

    const antiga = await items(service.lastInsertRowid, [
      { catalogId: catalog.lastInsertRowid, installedOn: '2025-12-31' }
    ]);
    expect(antiga.statusCode).toBe(400);
    expect((antiga.json() as { error: string }).error).toContain('ativação do serviço');
  });

  test('recusa recolher antes de ter instalado', async () => {
    const { service, catalog } = seedDatedService();
    const created = await items(service.lastInsertRowid, [
      { catalogId: catalog.lastInsertRowid, installedOn: '2026-05-10' }
    ]);
    const assignmentId = (created.json() as { assignmentIds: number[] }).assignmentIds[0];

    const response = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/return`,
      payload: { returnedOn: '2026-05-09' }
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('anterior à instalação');
  });

  test('a devolucao datada fecha no dia certo e devolve o stock nesse dia', async () => {
    const { service, catalog } = seedDatedService();
    const created = await items(service.lastInsertRowid, [
      { catalogId: catalog.lastInsertRowid, installedOn: '2026-05-10' }
    ]);
    const assignmentId = (created.json() as { assignmentIds: number[] }).assignmentIds[0];

    const response = await app.inject({
      method: 'POST',
      url: `/api/service-device-assignments/${assignmentId}/return`,
      payload: { returnedOn: '2026-06-20' }
    });

    expect(response.statusCode).toBe(200);
    expect(row('SELECT end_date AS d FROM service_device_assignments WHERE id = ?', assignmentId))
      .toEqual({ d: '2026-06-20' });
    expect(row("SELECT date(created_at) AS d FROM stock_movements WHERE type = 'devolucao' ORDER BY id DESC"))
      .toEqual({ d: '2026-06-20' });
  });

  test('corrigir a data de um registo antigo nao mexe no stock', async () => {
    const { service, catalog } = seedDatedService();
    const created = await items(service.lastInsertRowid, [{ catalogId: catalog.lastInsertRowid }]);
    const assignmentId = (created.json() as { assignmentIds: number[] }).assignmentIds[0];
    const antes = row('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?', catalog.lastInsertRowid);
    const movimentos = row('SELECT COUNT(*) AS n FROM stock_movements');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}/dates`,
      payload: { startDate: '2026-02-14' }
    });

    expect(response.statusCode).toBe(200);
    expect(row('SELECT start_date AS d FROM service_device_assignments WHERE id = ?', assignmentId))
      .toEqual({ d: '2026-02-14' });
    expect(row('SELECT stock_total AS n FROM equipment_catalog WHERE id = ?', catalog.lastInsertRowid)).toEqual(antes);
    expect(row('SELECT COUNT(*) AS n FROM stock_movements')).toEqual(movimentos);
  });

  test('corrigir uma data recusa o que o formulario tambem recusaria', async () => {
    const { service, catalog } = seedDatedService();
    const created = await items(service.lastInsertRowid, [{ catalogId: catalog.lastInsertRowid }]);
    const assignmentId = (created.json() as { assignmentIds: number[] }).assignmentIds[0];

    const futura = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}/dates`,
      payload: { startDate: '2099-01-01' }
    });
    expect(futura.statusCode).toBe(400);

    // Fechar pela porta das traseiras: para isso ha a devolucao.
    const fecho = await app.inject({
      method: 'PATCH',
      url: `/api/service-device-assignments/${assignmentId}/dates`,
      payload: { endDate: '2026-06-01' }
    });
    expect(fecho.statusCode).toBe(400);
    expect((fecho.json() as { error: string }).error).toContain('use a devolucao');
  });
});
