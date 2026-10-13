import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { computeMonthlyBilling, insertInstallationFeeIfDue } from './billing';
import { createManualInvoice } from './manual-invoice';
import { loadReceivables } from './receivables';
import { changeServiceStatus, createService, serviceSchema, updateService } from './services';
import { transferService } from './serviceTransfer';
import { isSystemClient } from './system-client';

let db: Database.Database;
afterEach(() => db?.close());
function fixture() {
  db = new Database(':memory:');
  runMigrations(db);
  const system = db.prepare("SELECT id FROM clients WHERE system_kind = 'indifferentiated'").get() as { id: number };
  const clientId = Number(db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('REAL', 'Cliente real')").run().lastInsertRowid);
  const serviceId = Number(db.prepare("INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 2500, 'active')").run(clientId).lastInsertRowid);
  return { systemId: system.id, clientId, serviceId };
}

describe('reserved system client', () => {
  test('uses the persisted identity even if the name resembles a normal client', () => {
    const { systemId, clientId } = fixture();
    db.prepare("UPDATE clients SET full_name = 'Outro nome' WHERE id = ?").run(systemId);
    db.prepare("UPDATE clients SET full_name = 'Cliente Indiferenciado' WHERE id = ?").run(clientId);
    expect(isSystemClient(db, systemId)).toBe(true);
    expect(isSystemClient(db, clientId)).toBe(false);
    expect(isSystemClient(db, 999999)).toBe(false);
  });

  test('rejects service creation, reassignment and transfer without writes', () => {
    const { systemId, clientId, serviceId } = fixture();
    const data = serviceSchema.parse({ clientId: systemId, monthlyValueCve: 2500 });
    expect(createService(db, data, null)).toMatchObject({ ok: false, status: 409 });
    expect(updateService(db, serviceId, data)).toMatchObject({ ok: false, status: 409 });
    expect(transferService(db, serviceId, { toClientId: systemId, mode: 'manter', reactivateService: true }, null))
      .toMatchObject({ ok: false, status: 409 });
    expect(db.prepare('SELECT client_id AS clientId FROM services WHERE id = ?').get(serviceId)).toEqual({ clientId });
    expect(db.prepare('SELECT COUNT(*) AS n FROM services').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_events').get()).toEqual({ n: 0 });
  });

  test('rejects manual FT before number allocation and payment creation', () => {
    const { systemId } = fixture();
    expect(createManualInvoice(db, { clientId: systemId, lines: [{ description: 'Material', amountCve: 500 }] }, null))
      .toMatchObject({ ok: false, status: 409 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 0 });
  });

  test('omits imported legacy system services from billing and refuses their state changes', () => {
    const { systemId, serviceId } = fixture();
    const systemServiceId = Number(db.prepare("INSERT INTO services (client_id, monthly_value_cve, status) VALUES (?, 5000, 'active')").run(systemId).lastInsertRowid);
    expect(computeMonthlyBilling(db, '2026-10').toCreate.map(item => item.serviceId)).toEqual([serviceId]);
    expect(insertInstallationFeeIfDue(db, { serviceId: systemServiceId, clientId: systemId, amountCve: 500 })).toBeNull();
    expect(changeServiceStatus(db, systemServiceId, 'suspended')).toMatchObject({ ok: false, status: 409 });
    expect(changeServiceStatus(db, systemServiceId, 'cancelled')).toMatchObject({ ok: false, status: 409 });
    expect(db.prepare('SELECT status FROM services WHERE id = ?').get(systemServiceId)).toEqual({ status: 'active' });
    db.prepare("INSERT INTO payments (client_id, reference_month, amount_cve, due_date, status) VALUES (?, 'AVULSA-1', 500, '2026-09-01', 'overdue')").run(systemId);
    expect(loadReceivables(db).clients).toHaveLength(0);
  });
});
