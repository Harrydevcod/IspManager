import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { serviceTransferSchema, transferService } from './serviceTransfer';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

type Seed = {
  actorId: number;
  catalogId: number;
  oldClientId: number;
  newClientId: number;
  returningClientId: number;
  serviceId: number;
  assignmentId: number;
  backboneId: number;
  linkId: number;
};

function seed(db: Database.Database): Seed {
  const actor = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name)
    VALUES ('operator', 'hash', 'operator', 'Operador')
  `).run();
  const catalog = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'cpe', 'TP-Link', 'CPE710', 1, 8000, 5, 1)
  `).run();
  const oldClient = db.prepare(`
    INSERT INTO clients (client_code, full_name, island, zone, status)
    VALUES ('CLT-001', 'Ana Silva', 'Santiago', 'Praia', 'cancelled')
  `).run();
  const newClient = db.prepare(`
    INSERT INTO clients (client_code, full_name, island, zone, status)
    VALUES ('CLT-002', 'Bruno Tavares', 'Santiago', 'Praia', 'active')
  `).run();
  const returningClient = db.prepare(`
    INSERT INTO clients (client_code, full_name, island, zone, status)
    VALUES ('CLT-003', 'Carla Monteiro', 'Santiago', 'Praia', 'cancelled')
  `).run();
  const service = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status, ip_address, pppoe_username, pppoe_password)
    VALUES (?, 2500, 10, 'cancelled', '10.0.0.10', 'ana-silva-1', 'segredo')
  `).run(oldClient.lastInsertRowid);
  const assignment = db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, serial_number, ip_address, ownership, rental_fee_cve)
    VALUES (?, ?, 'CPE-01', '10.0.0.10', 'isp', 250)
  `).run(service.lastInsertRowid, catalog.lastInsertRowid);
  const backbone = db.prepare(`
    INSERT INTO backbone_devices (catalog_id, name, ip_address, status)
    VALUES (?, 'Antena Achada', '10.0.0.2', 'active')
  `).run(catalog.lastInsertRowid);
  const link = db.prepare(`
    INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id, created_by)
    VALUES (?, ?, ?)
  `).run(backbone.lastInsertRowid, assignment.lastInsertRowid, actor.lastInsertRowid);

  return {
    actorId: Number(actor.lastInsertRowid),
    catalogId: Number(catalog.lastInsertRowid),
    oldClientId: Number(oldClient.lastInsertRowid),
    newClientId: Number(newClient.lastInsertRowid),
    returningClientId: Number(returningClient.lastInsertRowid),
    serviceId: Number(service.lastInsertRowid),
    assignmentId: Number(assignment.lastInsertRowid),
    backboneId: Number(backbone.lastInsertRowid),
    linkId: Number(link.lastInsertRowid)
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return serviceTransferSchema.parse({ toClientId: 0, ...overrides });
}

function serviceRow(db: Database.Database, id: number) {
  return db.prepare(`
    SELECT client_id AS clientId, status, ip_address AS ipAddress,
           pppoe_username AS pppoeUsername, pppoe_password AS pppoePassword
    FROM services WHERE id = ?
  `).get(id) as {
    clientId: number;
    status: string;
    ipAddress: string | null;
    pppoeUsername: string | null;
    pppoePassword: string | null;
  };
}

function eventTypes(db: Database.Database, serviceId: number): string[] {
  return (db.prepare('SELECT event_type AS eventType FROM service_events WHERE service_id = ? ORDER BY id')
    .all(serviceId) as Array<{ eventType: string }>).map((row) => row.eventType);
}

describe('transferService', () => {
  test('muda o titular e deixa a faturacao emitida com o cliente antigo', () => {
    const db = freshDb();
    const fixture = seed(db);
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-05', 2750, '2026-06-30', 'paid')
    `).run(fixture.oldClientId, fixture.serviceId);

    const result = transferService(db, fixture.serviceId, input({ toClientId: fixture.newClientId }), fixture.actorId);

    expect(result.ok).toBe(true);
    expect(serviceRow(db, fixture.serviceId).clientId).toBe(fixture.newClientId);
    expect(db.prepare('SELECT client_id AS clientId FROM payments WHERE service_id = ?').get(fixture.serviceId))
      .toEqual({ clientId: fixture.oldClientId });
  });

  test('regista o evento de transferencia com os dois nomes e o motivo', () => {
    const db = freshDb();
    const fixture = seed(db);

    transferService(
      db,
      fixture.serviceId,
      input({ toClientId: fixture.newClientId, reason: 'Mudanca de inquilino' }),
      fixture.actorId
    );

    const event = db.prepare(`
      SELECT notes, created_by AS createdBy FROM service_events
      WHERE service_id = ? AND event_type = 'transferencia'
    `).get(fixture.serviceId) as { notes: string; createdBy: number };
    expect(event.notes).toContain('Ana Silva');
    expect(event.notes).toContain('Bruno Tavares');
    expect(event.notes).toContain('Mudanca de inquilino');
    expect(event.createdBy).toBe(fixture.actorId);
    // Reativação e transferência são dois factos distintos na cronologia.
    expect(eventTypes(db, fixture.serviceId)).toEqual(['transferencia', 'reativacao']);
  });

  test('reativa o cliente cancelado que regressa e o proprio servico', () => {
    const db = freshDb();
    const fixture = seed(db);

    const result = transferService(
      db,
      fixture.serviceId,
      input({ toClientId: fixture.returningClientId }),
      fixture.actorId
    );

    expect(result.ok && result.value.clientReactivated).toBe(true);
    expect(db.prepare('SELECT status FROM clients WHERE id = ?').get(fixture.returningClientId))
      .toEqual({ status: 'active' });
    expect(serviceRow(db, fixture.serviceId).status).toBe('active');
  });

  test('reactivateService a false deixa o servico como estava', () => {
    const db = freshDb();
    const fixture = seed(db);

    transferService(
      db,
      fixture.serviceId,
      input({ toClientId: fixture.newClientId, reactivateService: false }),
      fixture.actorId
    );

    expect(serviceRow(db, fixture.serviceId).status).toBe('cancelled');
    expect(eventTypes(db, fixture.serviceId)).toEqual(['transferencia']);
  });

  test('modo manter nao toca na instalacao fisica nem no PPPoE', () => {
    const db = freshDb();
    const fixture = seed(db);

    transferService(db, fixture.serviceId, input({ toClientId: fixture.newClientId, mode: 'manter' }), fixture.actorId);

    const service = serviceRow(db, fixture.serviceId);
    expect(service.ipAddress).toBe('10.0.0.10');
    expect(service.pppoeUsername).toBe('ana-silva-1');
    expect(service.pppoePassword).toBe('segredo');
    expect(db.prepare('SELECT ip_address AS ip, end_date AS endDate FROM service_device_assignments WHERE id = ?')
      .get(fixture.assignmentId)).toEqual({ ip: '10.0.0.10', endDate: null });
    expect(db.prepare('SELECT ended_at AS endedAt FROM backbone_assignment_links WHERE id = ?').get(fixture.linkId))
      .toEqual({ endedAt: null });
  });

  test('modo reinstalar liberta o IP, fecha a antena antiga e roda o PPPoE', () => {
    const db = freshDb();
    const fixture = seed(db);

    const result = transferService(
      db,
      fixture.serviceId,
      input({ toClientId: fixture.newClientId, mode: 'reinstalar' }),
      fixture.actorId
    );

    expect(result.ok && result.value.freedIps).toEqual(['10.0.0.10', '10.0.0.10']);
    const service = serviceRow(db, fixture.serviceId);
    expect(service.ipAddress).toBeNull();
    expect(service.pppoeUsername).toBe(`bruno-tavares-${fixture.serviceId}`);
    expect(service.pppoePassword).not.toBe('segredo');
    // O equipamento segue com o serviço: a atribuição não fecha, só perde o IP.
    expect(db.prepare('SELECT ip_address AS ip, end_date AS endDate FROM service_device_assignments WHERE id = ?')
      .get(fixture.assignmentId)).toEqual({ ip: null, endDate: null });
    const link = db.prepare('SELECT ended_at AS endedAt, ended_by AS endedBy FROM backbone_assignment_links WHERE id = ?')
      .get(fixture.linkId) as { endedAt: string | null; endedBy: number | null };
    expect(link.endedAt).not.toBeNull();
    expect(link.endedBy).toBe(fixture.actorId);
  });

  test('modo reinstalar recusa levar equipamento partilhado', () => {
    const db = freshDb();
    const fixture = seed(db);
    const other = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status)
      VALUES (?, 2500, 10, 'active')
    `).run(fixture.newClientId);
    db.prepare('INSERT INTO service_device_shares (assignment_id, service_id) VALUES (?, ?)')
      .run(fixture.assignmentId, other.lastInsertRowid);

    const result = transferService(
      db,
      fixture.serviceId,
      input({ toClientId: fixture.returningClientId, mode: 'reinstalar' }),
      fixture.actorId
    );

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(serviceRow(db, fixture.serviceId).clientId).toBe(fixture.oldClientId);
  });

  test('avisa quando o servico ja nao tem equipamento instalado', () => {
    const db = freshDb();
    const fixture = seed(db);
    db.prepare(`UPDATE service_device_assignments SET end_date = date('now') WHERE id = ?`).run(fixture.assignmentId);

    const result = transferService(db, fixture.serviceId, input({ toClientId: fixture.newClientId }), fixture.actorId);

    expect(result.ok && result.value.warnings[0]).toContain('nao tem equipamento instalado');
  });

  test('recusa o mesmo cliente e o cliente inexistente', () => {
    const db = freshDb();
    const fixture = seed(db);

    expect(transferService(db, fixture.serviceId, input({ toClientId: fixture.oldClientId }), null))
      .toMatchObject({ ok: false, status: 400 });
    expect(transferService(db, fixture.serviceId, input({ toClientId: 9999 }), null))
      .toMatchObject({ ok: false, status: 404 });
    expect(transferService(db, 9999, input({ toClientId: fixture.newClientId }), null))
      .toMatchObject({ ok: false, status: 404 });
  });
});
