import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { loadServiceRentals } from './billing';
import { ownedSharedAssignments, promoteAssignmentOwner, sharerServices } from './deviceShares';
import { returnAssignmentWithinTx } from './serviceReturn';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-shares-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of [
    'service_device_shares',
    'stock_movements',
    'service_events',
    'service_device_assignments',
    'services',
    'clients',
    'equipment_catalog'
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

// ------------------------------------------------------------------ seeds

function seedCatalog(): number {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, unit_of_measure, is_serialized, stock_total, purchase_price_cve, rental_fee_cve)
    VALUES ('equipamento', 'antena', 'TP-Link', 'CPE 510', 'un', 1, 5, 6000, 250)
  `).run().lastInsertRowid);
}

function seedService(name: string, ip: string | null = null): number {
  const clientId = Number(db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(`C${name}`, name).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO services (client_id, status, monthly_value_cve, due_day, ip_address)
    VALUES (?, 'active', 2500, 10, ?)
  `).run(clientId, ip).lastInsertRowid);
}

function assign(serviceId: number, catalogId: number, ip: string | null = null): number {
  return Number(db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, start_date, ownership, rental_fee_cve, ip_address)
    VALUES (?, ?, date('now'), 'isp', 250, ?)
  `).run(serviceId, catalogId, ip).lastInsertRowid);
}

function share(assignmentId: number, serviceId: number) {
  db.prepare('INSERT INTO service_device_shares (assignment_id, service_id) VALUES (?, ?)')
    .run(assignmentId, serviceId);
}

const ownerOf = (assignmentId: number) =>
  (db.prepare('SELECT service_id AS serviceId FROM service_device_assignments WHERE id = ?')
    .get(assignmentId) as { serviceId: number }).serviceId;

const serviceIp = (serviceId: number) =>
  (db.prepare('SELECT ip_address AS ip FROM services WHERE id = ?').get(serviceId) as { ip: string | null }).ip;

const input = (serviceId: number, keep = false) => ({ serviceId, keepPreviousAsShare: keep, reason: null });

// ------------------------------------------------------- passar titularidade

describe('promover um vizinho a titular da antena', () => {
  test('o vizinho passa a titular e deixa de ser partilha', () => {
    const titular = seedService('Titular');
    const vizinho = seedService('Vizinho');
    const assignmentId = assign(titular, seedCatalog());
    share(assignmentId, vizinho);

    const result = promoteAssignmentOwner(db, assignmentId, input(vizinho), null);

    expect(result).toMatchObject({ ok: true });
    expect(ownerOf(assignmentId)).toBe(vizinho);
    expect(sharerServices(db, assignmentId)).toEqual([]);
  });

  test('com a opção ligada, o titular antigo fica como partilha', () => {
    const titular = seedService('Titular');
    const vizinho = seedService('Vizinho');
    const assignmentId = assign(titular, seedCatalog());
    share(assignmentId, vizinho);

    promoteAssignmentOwner(db, assignmentId, input(vizinho, true), null);

    expect(ownerOf(assignmentId)).toBe(vizinho);
    expect(sharerServices(db, assignmentId).map((row) => row.serviceId)).toEqual([titular]);
  });

  test('a renda passa a ser cobrada ao novo titular', () => {
    const titular = seedService('Titular');
    const vizinho = seedService('Vizinho');
    const assignmentId = assign(titular, seedCatalog());
    share(assignmentId, vizinho);

    expect(loadServiceRentals(db).get(titular)).toHaveLength(1);

    promoteAssignmentOwner(db, assignmentId, input(vizinho), null);

    const rentals = loadServiceRentals(db);
    expect(rentals.get(titular)).toBeUndefined();
    expect(rentals.get(vizinho)).toEqual([
      expect.objectContaining({ assignmentId, amountCve: 250 })
    ]);
  });

  test('o IP da unidade deixa de estar pendurado no serviço antigo', () => {
    const titular = seedService('Titular', '10.0.0.7');
    const vizinho = seedService('Vizinho');
    const assignmentId = assign(titular, seedCatalog(), '10.0.0.7');
    share(assignmentId, vizinho);

    promoteAssignmentOwner(db, assignmentId, input(vizinho), null);

    expect(serviceIp(titular)).toBeNull();
  });

  test('escreve um evento em cada um dos serviços', () => {
    const titular = seedService('Titular');
    const vizinho = seedService('Vizinho');
    const assignmentId = assign(titular, seedCatalog());
    share(assignmentId, vizinho);

    promoteAssignmentOwner(db, assignmentId, input(vizinho), null);

    const events = db.prepare('SELECT service_id AS serviceId, notes FROM service_events ORDER BY service_id')
      .all() as Array<{ serviceId: number; notes: string }>;
    expect(events.map((row) => row.serviceId).sort()).toEqual([titular, vizinho].sort());
    expect(events[0].notes).toContain('Titularidade da antena');
  });

  test('depois da promoção o antigo titular já pode cancelar e o novo pode devolver', () => {
    const titular = seedService('Titular');
    const vizinho = seedService('Vizinho');
    const catalogId = seedCatalog();
    const assignmentId = assign(titular, catalogId);
    share(assignmentId, vizinho);

    promoteAssignmentOwner(db, assignmentId, input(vizinho), null);

    expect(ownedSharedAssignments(db, titular)).toEqual([]);
    expect(() => returnAssignmentWithinTx(db, {
      assignmentId,
      serviceId: vizinho,
      clientName: 'Vizinho',
      condition: 'bom',
      userId: null
    })).not.toThrow();
  });
});

describe('guardas', () => {
  test('recusa um serviço que não é servido por esta antena', () => {
    const titular = seedService('Titular');
    const estranho = seedService('Estranho');
    const assignmentId = assign(titular, seedCatalog());

    expect(promoteAssignmentOwner(db, assignmentId, input(estranho), null))
      .toMatchObject({ ok: false, status: 409 });
    expect(ownerOf(assignmentId)).toBe(titular);
  });

  test('recusa o próprio titular', () => {
    const titular = seedService('Titular');
    const assignmentId = assign(titular, seedCatalog());

    expect(promoteAssignmentOwner(db, assignmentId, input(titular), null))
      .toMatchObject({ ok: false, status: 409 });
  });

  test('recusa uma atribuição já encerrada', () => {
    const titular = seedService('Titular');
    const vizinho = seedService('Vizinho');
    const assignmentId = assign(titular, seedCatalog());
    share(assignmentId, vizinho);
    db.prepare("UPDATE service_device_assignments SET end_date = date('now') WHERE id = ?").run(assignmentId);

    expect(promoteAssignmentOwner(db, assignmentId, input(vizinho), null))
      .toMatchObject({ ok: false, status: 400 });
  });

  test('recusa atribuição inexistente e serviço inexistente', () => {
    const titular = seedService('Titular');
    const assignmentId = assign(titular, seedCatalog());

    expect(promoteAssignmentOwner(db, 9999, input(titular), null)).toMatchObject({ ok: false, status: 404 });
    expect(promoteAssignmentOwner(db, assignmentId, input(9999), null)).toMatchObject({ ok: false, status: 404 });
  });
});
