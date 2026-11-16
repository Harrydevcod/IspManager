import { afterEach, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { issueCustomerPortal, revokeCustomerPortal } from './customer-portal-publish';

afterEach(() => vi.unstubAllGlobals());
test('publishes ciphertext and revokes without sending the decryption key to the relay', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE customer_portal_links(id TEXT PRIMARY KEY, client_id INTEGER, relay_origin TEXT, expires_at INTEGER, published_at TEXT, revoked_at TEXT);
    CREATE TABLE clients(id INTEGER PRIMARY KEY, full_name TEXT, client_code TEXT, system_kind TEXT);
    CREATE TABLE services(id INTEGER, client_id INTEGER, plan_id INTEGER, status TEXT);
    CREATE TABLE internet_plans(id INTEGER, name TEXT);
    CREATE TABLE payments(id INTEGER, client_id INTEGER, amount_cve REAL, status TEXT, document_type TEXT, invoice_number TEXT, due_date TEXT, service_id INTEGER, reference_month TEXT, invoice_date TEXT);
    CREATE TABLE payment_lines(payment_id INTEGER, kind TEXT, description TEXT, sort_order INTEGER, id INTEGER);
    CREATE TABLE payment_receipts(payment_id INTEGER, amount_cve REAL, voided_at TEXT);
    CREATE TABLE client_credits(client_id INTEGER, amount_cve REAL);
    INSERT INTO clients VALUES(1,'Ana','C1',NULL);`);
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  try {
    const result = await issueCustomerPortal(db, 1, 'https://relay.example', 'secret', new Date('2026-11-16T12:00:00Z'));
    const key = new URL(result.url).hash.slice(1);
    const body = String(fetch.mock.calls[0][1]?.body);
    expect(body).not.toContain('Ana');
    expect(body).not.toContain(key);
    expect(fetch.mock.calls[0][0]).not.toContain(key);
    await expect(revokeCustomerPortal(db, result.id, 'https://other.example', 'secret')).rejects.toThrow();
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await revokeCustomerPortal(db, result.id, 'https://relay.example', 'secret');
    expect(db.prepare('SELECT revoked_at FROM customer_portal_links WHERE id=?').get(result.id)).toMatchObject({ revoked_at: expect.any(String) });
  } finally { db.close(); }
});

test('o relé segue a regra do relé SMS: HTTPS, HTTP só local, e sem caminho', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE customer_portal_links(id TEXT PRIMARY KEY, client_id INTEGER, relay_origin TEXT, expires_at INTEGER, published_at TEXT, revoked_at TEXT);
    CREATE TABLE clients(id INTEGER PRIMARY KEY, full_name TEXT, client_code TEXT, system_kind TEXT);
    CREATE TABLE services(id INTEGER, client_id INTEGER, plan_id INTEGER, status TEXT);
    CREATE TABLE internet_plans(id INTEGER, name TEXT);
    CREATE TABLE payments(id INTEGER, client_id INTEGER, amount_cve REAL, status TEXT, document_type TEXT, invoice_number TEXT, due_date TEXT, service_id INTEGER, reference_month TEXT, invoice_date TEXT);
    CREATE TABLE payment_lines(payment_id INTEGER, kind TEXT, description TEXT, sort_order INTEGER, id INTEGER);
    CREATE TABLE payment_receipts(payment_id INTEGER, amount_cve REAL, voided_at TEXT);
    CREATE TABLE client_credits(client_id INTEGER, amount_cve REAL);
    INSERT INTO clients VALUES(1,'Ana','C1',NULL);`);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })));
  try {
    for (const bad of ['http://relay.example', 'https://relay.example/sub', 'https://u:p@relay.example', 'ftp://relay.example']) {
      await expect(issueCustomerPortal(db, 1, bad, 'secret')).rejects.toThrow('Endereço do relé inválido');
    }
    expect((await issueCustomerPortal(db, 1, 'http://127.0.0.1:8787/', 'secret')).url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/customer\/[0-9a-f]{64}#/);
    expect((await issueCustomerPortal(db, 1, 'https://relay.example/', 'secret')).url).toMatch(/^https:\/\/relay\.example\/customer\//);
  } finally { db.close(); }
});
