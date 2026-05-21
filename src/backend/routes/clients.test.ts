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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-clients-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM work_orders').run();
  db.prepare('DELETE FROM service_events').run();
  db.prepare('DELETE FROM service_device_assignments').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM stock_movements').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM app_settings').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

describe('POST /api/clients/bulk', () => {
  test('inserts new rows and auto-generates clientCode when missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/bulk',
      payload: {
        rows: [
          { fullName: 'Maria Tavares', phone: '9111111' },
          { fullName: 'Joao Silva', nif: '123456789', email: 'joao@example.com' }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ received: 2, inserted: 2, skipped: 0, errors: 0 });
    expect(body.inserted).toHaveLength(2);
    expect(body.inserted[0].clientCode).toMatch(/^CLT-\d{4}$/);

    const stored = db.prepare('SELECT full_name, phone, nif, email FROM clients ORDER BY id').all();
    expect(stored).toEqual([
      { full_name: 'Maria Tavares', phone: '9111111', nif: null, email: null },
      { full_name: 'Joao Silva', phone: null, nif: '123456789', email: 'joao@example.com' }
    ]);
  });

  test('skips duplicates by clientCode, NIF, and phone without aborting the batch', async () => {
    db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, nif, status)
      VALUES ('CLT-EXIST', 'Existente', '9999999', '987654321', 'active')
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/bulk',
      payload: {
        rows: [
          { fullName: 'Novo Cliente', phone: '9000001' },
          { fullName: 'Dup Code', clientCode: 'CLT-EXIST' },
          { fullName: 'Dup NIF', nif: '987654321' },
          { fullName: 'Dup Phone', phone: '9999999' }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ received: 4, inserted: 1, skipped: 3, errors: 0 });
    const reasons = body.skipped.map((row: any) => row.reason).sort();
    expect(reasons).toEqual(['clientCode_duplicate', 'nif_duplicate', 'phone_duplicate']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM clients').get()).toEqual({ n: 2 });
  });

  test('reports validation errors per row without rolling back valid inserts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/bulk',
      payload: {
        rows: [
          { fullName: 'OK Person' },
          { fullName: '', phone: '9000002' }, // empty name
          { fullName: 'Bad NIF', nif: '12' }, // not 9 digits
          { fullName: 'Bad Email', email: 'not-an-email' }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ received: 4, inserted: 1, skipped: 0, errors: 3 });
    expect(body.errors).toHaveLength(3);
    expect(body.errors.every((row: any) => row.reason === 'validation')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM clients').get()).toEqual({ n: 1 });
  });
});
