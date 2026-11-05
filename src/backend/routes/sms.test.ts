import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { writeSecret } from '../lib/secrets';

// The LAN scan is the only thing faked: discovery tests choose who answers.
const discovery = vi.hoisted(() => ({ hosts: [] as string[], paired: null as string | null }));
vi.mock('../lib/sms-outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sms-outbox')>()),
  discoverCompanionHosts: async () => discovery.hosts,
  findPairedCompanion: async () => discovery.paired
}));

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-sms-routes-'));
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
  vi.unstubAllGlobals();
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
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

function seedPaidPayment() {
  const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C1','Ana','9912233','active')`).run().lastInsertRowid as number;
  const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?,4500,10,'active')`).run(clientId).lastInsertRowid as number;
  const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status, receipt_number) VALUES (?,?,'2026-06',4500,'2026-06-10','2026-06-04','paid','RC-1')`).run(clientId, serviceId).lastInsertRowid as number;
  return { clientId, serviceId, paymentId };
}

function seedSmsReportRow(status: string, createdAt: string) {
  db.prepare(`
    INSERT INTO sms_outbox
      (event_type, to_phone, body, status, created_at, updated_at)
    VALUES ('test', '+2389912233', 'teste', ?, ?, ?)
  `).run(status, createdAt, createdAt);
}

describe('SMS routes', () => {
  test('GET /api/sms/status returns pairing and connectivity without report counts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sms/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      configured: false,
      paired: false,
      reachable: false,
      active: false,
      baseUrl: '',
      deviceName: '',
      lastSeen: null,
      device: null
    });
  });

  test('GET /api/sms/status reports saved pairing as inactive when Android is unreachable', async () => {
    db.prepare(`
      INSERT INTO app_settings (key,value) VALUES
      ('smsCompanionEnabled','true'),
      ('smsCompanionBaseUrl','http://192.168.1.50:8765'),
      ('smsCompanionDeviceName','Android A')
    `).run();
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const response = await app.inject({ method: 'GET', url: '/api/sms/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      paired: false,
      reachable: false,
      active: false,
      baseUrl: 'http://192.168.1.50:8765',
      deviceName: 'Android A'
    });
  });

  test.each(['/api/sms/report', '/api/sms/report?month=2026-13'])(
    'GET %s rejects an invalid month',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
    }
  );

  test('GET /api/sms/report returns zero counts for an empty month', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sms/report?month=2026-07' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      month: '2026-07',
      timezone: 'Atlantic/Cape_Verde',
      counts: {
        pendingDispatch: 0,
        pendingApproval: 0,
        sent: 0,
        delivered: 0,
        failed: 0,
        rejected: 0
      }
    });
  });

  test('GET /api/sms/report uses Cape Verde creation-month boundaries', async () => {
    seedSmsReportRow('pending_dispatch', '2026-07-01 00:59:59');
    seedSmsReportRow('pending_approval', '2026-07-01 01:00:00');
    seedSmsReportRow('sent', '2026-07-15 12:00:00');
    seedSmsReportRow('failed', '2026-08-01 00:30:00');
    seedSmsReportRow('rejected', '2026-08-01 01:00:00');

    const response = await app.inject({ method: 'GET', url: '/api/sms/report?month=2026-07' });

    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toEqual({
      pendingDispatch: 0,
      pendingApproval: 1,
      sent: 1,
      delivered: 0,
      failed: 1,
      rejected: 0
    });
  });

  test('GET /api/sms/status with the connection off never contacts the phone but keeps the pairing', async () => {
    db.prepare(`
      INSERT INTO app_settings (key,value) VALUES
      ('smsCompanionEnabled','false'),
      ('smsCompanionBaseUrl','http://192.168.1.50:8765'),
      ('smsCompanionDeviceName','Android A')
    `).run();
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({ method: 'GET', url: '/api/sms/status' });

    expect(response.json()).toMatchObject({ enabled: false, configured: true, reachable: false, active: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('GET /api/sms/pairing/verify with the connection off never contacts the phone', async () => {
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionEnabled','false'), ('smsCompanionBaseUrl','http://192.168.1.50:8765')`).run();
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({ method: 'GET', url: '/api/sms/pairing/verify' });

    expect(response.json()).toMatchObject({ reachable: false, paired: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('POST /api/sms/pairing creates a pairing payload and stores the pairing config', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sms/pairing', payload: { baseUrl: 'http://192.168.1.50:8765', deviceName: 'Android A' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.qrPayload).toContain('ispm-sms://pair');
    expect(body.secret).toBeTruthy();

    const status = await app.inject({ method: 'GET', url: '/api/sms/status' });
    expect(status.json()).toMatchObject({ configured: true });
  });

  test('POST /api/sms/discover saves the new IP of the phone found by its secret', async () => {
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionEnabled','true'), ('smsCompanionBaseUrl','http://192.168.1.126:8765')`).run();
    writeSecret(db, 'smsCompanionPairingKey', 'segredo');
    discovery.hosts = ['http://192.168.0.17:8765', 'http://192.168.0.30:8765'];
    discovery.paired = 'http://192.168.0.17:8765';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); })); // the saved IP is dead

    const response = await app.inject({ method: 'POST', url: '/api/sms/discover' });
    expect(response.json()).toMatchObject({ baseUrl: 'http://192.168.0.17:8765', paired: true, updated: true });
    const saved = db.prepare(`SELECT value FROM app_settings WHERE key='smsCompanionBaseUrl'`).get() as { value: string };
    expect(saved.value).toBe('http://192.168.0.17:8765');
  });

  test('POST /api/sms/discover keeps a saved address that still answers with the secret', async () => {
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionEnabled','true'), ('smsCompanionBaseUrl','http://192.168.1.126:8765')`).run();
    writeSecret(db, 'smsCompanionPairingKey', 'segredo');
    discovery.hosts = ['http://192.168.0.66:8765'];
    discovery.paired = 'http://192.168.0.66:8765';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))); // saved phone still verifies

    const response = await app.inject({ method: 'POST', url: '/api/sms/discover' });
    expect(response.json()).toMatchObject({ updated: false });
    const saved = db.prepare(`SELECT value FROM app_settings WHERE key='smsCompanionBaseUrl'`).get() as { value: string };
    expect(saved.value).toBe('http://192.168.1.126:8765');
  });

  test('POST /api/sms/discover never saves an address that did not prove the secret', async () => {
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionBaseUrl','http://192.168.1.126:8765')`).run();
    writeSecret(db, 'smsCompanionPairingKey', 'segredo');
    discovery.hosts = ['http://192.168.0.30:8765'];
    discovery.paired = null;

    const response = await app.inject({ method: 'POST', url: '/api/sms/discover' });
    expect(response.json()).toMatchObject({ baseUrl: 'http://192.168.0.30:8765', paired: false, updated: false });
    const saved = db.prepare(`SELECT value FROM app_settings WHERE key='smsCompanionBaseUrl'`).get() as { value: string };
    expect(saved.value).toBe('http://192.168.1.126:8765');
  });

  test('DELETE /api/sms/pairing revokes the companion', async () => {
    await app.inject({ method: 'POST', url: '/api/sms/pairing', payload: { baseUrl: 'http://192.168.1.50:8765', deviceName: 'Android A' } });
    const response = await app.inject({ method: 'DELETE', url: '/api/sms/pairing' });
    expect(response.statusCode).toBe(200);
    const status = await app.inject({ method: 'GET', url: '/api/sms/status' });
    expect(status.json()).toMatchObject({ paired: false });
  });

  test('POST /api/payments/:id/sms enqueues receipt SMS', async () => {
    const { paymentId } = seedPaidPayment();
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'receipt_confirmed' } });
    expect(response.statusCode).toBe(200);
    const row = db.prepare('SELECT event_type, status, to_phone FROM sms_outbox').get() as { event_type: string; status: string; to_phone: string };
    expect(row).toMatchObject({ event_type: 'receipt_confirmed', status: 'pending_dispatch', to_phone: '+2389912233' });
  });

  test('POST /api/payments/:id/sms rejects a receipt for an unpaid payment', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C2','Beto','9912244','active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?,4500,10,'active')`).run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?,?,'2026-06',4500,'2026-06-10','pending')`).run(clientId, serviceId).lastInsertRowid as number;
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'receipt_confirmed' } });
    expect(response.statusCode).toBe(400);
  });

  test('POST /api/payments/:id/sms rejects a client without phone', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('C3','Sem Fone', NULL,'active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?,4500,10,'active')`).run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?,?,'2026-06',4500,'2026-06-10','overdue')`).run(clientId, serviceId).lastInsertRowid as number;
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'payment_overdue' } });
    expect(response.statusCode).toBe(400);
  });

  test('POST /api/payments/:id/sms rejects an unknown event type', async () => {
    const { paymentId } = seedPaidPayment();
    const response = await app.inject({ method: 'POST', url: `/api/payments/${paymentId}/sms`, payload: { eventType: 'nonsense' } });
    expect(response.statusCode).toBe(400);
  });
});
