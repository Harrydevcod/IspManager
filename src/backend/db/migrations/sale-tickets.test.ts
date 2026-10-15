import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { runMigrations } from '../migrate';
import { migrations } from '.';

let db: Database.Database;
afterEach(() => db?.close());

test('base nova contém um único Cliente Indiferenciado sem NIF e campos TV', () => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  runMigrations(db); runMigrations(db);
  expect(db.prepare("SELECT full_name,nif,status FROM clients WHERE system_kind='indifferentiated'").all())
    .toEqual([{ full_name: 'Cliente Indiferenciado', nif: null, status: 'active' }]);
  expect(() => db.prepare("INSERT INTO clients(client_code,full_name,system_kind) VALUES ('SECOND','Duplicado','indifferentiated')").run()).toThrow(/UNIQUE/);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

test('upgrade preserva FT, linhas e recebimentos e evita colisão de código/nome', () => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  runMigrations(db, migrations.filter((migration) => migration.version < 83));
  const clientId = Number(db.prepare("INSERT INTO clients(client_code,full_name,nif) VALUES ('INDIF','Cliente Indiferenciado','12345')").run().lastInsertRowid);
  const paymentId = Number(db.prepare("INSERT INTO payments(client_id,reference_month,amount_cve,due_date,invoice_number,status) VALUES (?,'AVULSA-1',100,'2026-10-01','FT-2026-00001','paid')").run(clientId).lastInsertRowid);
  db.prepare("INSERT INTO payment_lines(payment_id,kind,description,amount_cve) VALUES (?,'avulso','Linha existente',100)").run(paymentId);
  db.prepare("INSERT INTO payment_receipts(payment_id,amount_cve,payment_date,payment_method,receipt_number,receipt_date) VALUES (?,100,'2026-10-01','numerario','RC-2026-00001','2026-10-01')").run(paymentId);
  const before = db.prepare('SELECT * FROM payment_receipts').all();
  runMigrations(db); runMigrations(db);
  expect(db.prepare('SELECT * FROM payment_receipts').all()).toEqual(before);
  expect(db.prepare('SELECT invoice_number,document_type FROM payments').all()).toEqual([{ invoice_number: 'FT-2026-00001', document_type: 'invoice' }]);
  expect(db.prepare('SELECT description FROM payment_lines').all()).toEqual([{ description: 'Linha existente' }]);
  expect(db.prepare("SELECT id,client_code,nif FROM clients WHERE system_kind='indifferentiated'").all())
    .toEqual([{ id: expect.any(Number), client_code: 'VD', nif: null }]);
  expect(db.prepare('SELECT system_kind FROM clients WHERE id=?').get(clientId)).toEqual({ system_kind: null });
  expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
