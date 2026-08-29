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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-dq-test-'));
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
  _clientSeq = 0;
  db.prepare('DELETE FROM client_duplicate_dismissals').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
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

let _clientSeq = 0;
const insertClient = (over: Record<string, unknown> = {}) => {
  _clientSeq++;
  const seq = String(_clientSeq).padStart(3, '0');
  const c = {
    client_code: `CLT-${seq}`, full_name: 'Ana Lima', phone: '9111111',
    nif: `10000${seq}`, address: 'Rua A', island: 'Santiago', zone: 'Praia',
    status: 'active', ...over
  };
  return db.prepare(`
    INSERT INTO clients (client_code, full_name, phone, nif, address, island, zone, status)
    VALUES (@client_code, @full_name, @phone, @nif, @address, @island, @zone, @status)
  `).run(c).lastInsertRowid as number;
};

describe('GET /api/reports/data-quality', () => {
  test('counts and lists incomplete clients by flag', async () => {
    insertClient({ client_code: 'CLT-0001', phone: null });
    insertClient({ client_code: 'CLT-0002', full_name: 'Bruno Sa', nif: null });

    const res = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incompleteCounts.noPhone).toBe(1);
    expect(body.incompleteCounts.noNif).toBe(1);
    expect(body.incompleteCounts.total).toBe(2);
    expect(body.incompleteClients).toHaveLength(2);
  });

  test('filters the incomplete list by issue', async () => {
    insertClient({ client_code: 'CLT-0001', phone: null });
    insertClient({ client_code: 'CLT-0002', full_name: 'Bruno Sa', nif: null, phone: '9222222' });

    const res = await app.inject({ method: 'GET', url: '/api/reports/data-quality?issue=noPhone' });
    const body = res.json();
    expect(body.incompleteClients.every((c: { flags: string[] }) => c.flags.includes('noPhone'))).toBe(true);
    expect(body.pagination.total).toBe(1);
  });

  test('reports possible duplicates by normalized phone', async () => {
    insertClient({ client_code: 'CLT-0001', full_name: 'Ana Lima', phone: '991 22 33' });
    insertClient({ client_code: 'CLT-0002', full_name: 'Ana M Lima', phone: '+238 9912233' });

    const res = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    const body = res.json();
    const phoneGroup = body.duplicateGroups.find((g: { reason: string }) => g.reason === 'phone');
    expect(phoneGroup.clients).toHaveLength(2);
  });
});

describe('POST /api/reports/data-quality/dismiss', () => {
  test('dismissing a pair removes it from duplicate detection and is idempotent', async () => {
    const a = insertClient({ client_code: 'CLT-0001', full_name: 'Ana Lima', phone: '991 22 33' });
    const b = insertClient({ client_code: 'CLT-0002', full_name: 'Ana M Lima', phone: '+238 9912233' });

    const before = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    expect(before.json().duplicateGroups.find((g: { reason: string }) => g.reason === 'phone')).toBeDefined();

    const first = await app.inject({
      method: 'POST', url: '/api/reports/data-quality/dismiss',
      payload: { clientIdA: b, clientIdB: a }
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST', url: '/api/reports/data-quality/dismiss',
      payload: { clientIdA: a, clientIdB: b }
    });
    expect(second.statusCode).toBe(200);
    const count = db.prepare('SELECT count(*) AS n FROM client_duplicate_dismissals').get() as { n: number };
    expect(count.n).toBe(1);

    const after = await app.inject({ method: 'GET', url: '/api/reports/data-quality' });
    expect(after.json().duplicateGroups.find((g: { reason: string }) => g.reason === 'phone')).toBeUndefined();
  });

  test('rejects an invalid pair', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/reports/data-quality/dismiss',
      payload: { clientIdA: 5, clientIdB: 5 }
    });
    expect(res.statusCode).toBe(400);
  });
});
