import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { buildCustomerPortalSnapshot } from './customer-portal-snapshot';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE clients (id INTEGER PRIMARY KEY, full_name TEXT, client_code TEXT, system_kind TEXT, nif TEXT, address TEXT, island TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE treasury_accounts (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, bank_name TEXT, holder_name TEXT, nib TEXT, account_number TEXT, reference TEXT, active INTEGER, show_on_documents INTEGER, sort_order INTEGER);
    CREATE TABLE services (id INTEGER PRIMARY KEY, client_id INTEGER, plan_id INTEGER, status TEXT);
    CREATE TABLE internet_plans (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, client_id INTEGER, amount_cve REAL, status TEXT, document_type TEXT, invoice_number TEXT, due_date TEXT, service_id INTEGER, reference_month TEXT, invoice_date TEXT);
    CREATE TABLE payment_lines (payment_id INTEGER, kind TEXT, description TEXT, sort_order INTEGER, id INTEGER PRIMARY KEY);
    CREATE TABLE payment_receipts (payment_id INTEGER, amount_cve REAL, voided_at TEXT);
    CREATE TABLE client_credits (client_id INTEGER, amount_cve REAL);
    INSERT INTO clients VALUES (1,'Ana','C1',NULL,'123456789','Achada Santo António','Santiago'),(2,'Outro','C2',NULL,NULL,NULL,NULL),(3,'Sistema','S','indifferentiated',NULL,NULL,NULL);
    INSERT INTO app_settings VALUES ('companyName','NovaTech'),('nif','212345678'),('address','Praia'),('island','Santiago'),('phone','2601234'),('email','geral@novatech.cv'),('ivaRate','15');
    INSERT INTO treasury_accounts VALUES (1,'banco','BCA','BCA','NovaTech Lda','0003 0000 12345678901 23',NULL,'',1,1,1),
      (2,'banco','CECV','CECV','NovaTech Lda',NULL,'987654',NULL,1,0,2),(3,'caixa','Caixa',NULL,NULL,NULL,NULL,NULL,1,1,0);
    INSERT INTO internet_plans VALUES (1,'Fibra');
    INSERT INTO services VALUES (1,1,1,'active'),(2,2,1,'suspended');
    INSERT INTO payments VALUES (1,1,1000,'pending','invoice','FT 1','2026-12-01',1,'2026-11',NULL),(2,2,999,'pending','invoice','FT 2','2026-12-01',2,'2026-11',NULL),(3,1,500,'cancelled','invoice','FT 3','2026-12-01',1,'2026-11',NULL);
    INSERT INTO payment_lines VALUES (1,'internet','Servico de Internet',0,1),(1,'audiovisual','TV',1,2);
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
      expect(result).toEqual({
        company: { name: 'NovaTech', nif: '212345678', address: 'Praia', island: 'Santiago', phone: '2601234', email: 'geral@novatech.cv' },
        customerName: 'Ana', customerCode: 'C1', customerNif: '123456789', customerAddress: 'Achada Santo António · Santiago',
        generatedAt: '2026-11-16T12:00:00.000Z', creditCents: 10000,
        invoices: [{ number: 'FT 1', dueDate: '2026-12-01', balanceCents: 75000, services: 'Internet Fibra e TV', period: 'novembro de 2026' }], services: [{ plan: 'Fibra', status: 'active' }],
        // Só a conta marcada para documentos; a desmarcada e a caixa ficam de fora.
        bankAccounts: [{ bank: 'BCA', holder: 'NovaTech Lda', account: '0003 0000 12345678901 23', reference: '' }] });
      expect(JSON.stringify(result)).not.toContain('Outro');
    } finally { db.close(); }
  });
  test('sem nada para liquidar não mostra contas para pagamento', () => {
    const db = fixture();
    try {
      db.exec("UPDATE payments SET status = 'paid' WHERE client_id = 1");
      expect(buildCustomerPortalSnapshot(db, 1, new Date()).bankAccounts).toEqual([]);
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
