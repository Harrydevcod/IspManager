import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { buildCustomerPortalSnapshot } from './customer-portal-snapshot';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE clients (id INTEGER PRIMARY KEY, full_name TEXT, client_code TEXT, system_kind TEXT);
    CREATE TABLE services (id INTEGER PRIMARY KEY, client_id INTEGER, plan_id INTEGER, status TEXT);
    CREATE TABLE internet_plans (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, client_id INTEGER, amount_cve REAL, status TEXT, document_type TEXT, invoice_number TEXT, due_date TEXT);
    CREATE TABLE payment_receipts (payment_id INTEGER, amount_cve REAL, voided_at TEXT);
    CREATE TABLE client_credits (client_id INTEGER, amount_cve REAL);
    INSERT INTO clients VALUES (1,'Ana','C1',NULL),(2,'Outro','C2',NULL),(3,'Sistema','S','indifferentiated');
    INSERT INTO internet_plans VALUES (1,'Fibra');
    INSERT INTO services VALUES (1,1,1,'active'),(2,2,1,'suspended');
    INSERT INTO payments VALUES (1,1,1000,'pending','invoice','FT 1','2026-12-01'),(2,2,999,'pending','invoice','FT 2','2026-12-01'),(3,1,500,'cancelled','invoice','FT 3','2026-12-01');
    INSERT INTO payment_receipts VALUES (1,250,NULL);
    INSERT INTO client_credits VALUES (1,100);
  `);
  return db;
}

describe('customer portal snapshot', () => {
  test('contains only this customer’s open balances and services', () => {
    const db = fixture();
    try {
      const result = buildCustomerPortalSnapshot(db, 1, new Date('2026-11-16T12:00:00Z'));
      expect(result).toEqual({ customerName: 'Ana', customerCode: 'C1', generatedAt: '2026-11-16T12:00:00.000Z', creditCents: 10000,
        invoices: [{ number: 'FT 1', dueDate: '2026-12-01', balanceCents: 75000 }], services: [{ plan: 'Fibra', status: 'active' }] });
      expect(JSON.stringify(result)).not.toContain('Outro');
    } finally { db.close(); }
  });
  test('rejects missing or system customer', () => {
    const db = fixture();
    try {
      expect(() => buildCustomerPortalSnapshot(db, 3, new Date())).toThrow();
      expect(() => buildCustomerPortalSnapshot(db, 42, new Date())).toThrow();
    } finally { db.close(); }
  });
});
