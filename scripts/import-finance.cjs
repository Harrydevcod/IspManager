const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourcePath = process.argv[2] || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ISPManager',
  'isp-manager.db'
);
const targetDir = process.env.ISPM_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ISPM'
);
const targetPath = path.join(targetDir, 'ispm.sqlite');

if (!fs.existsSync(sourcePath)) {
  console.error(`Base antiga nao encontrada: ${sourcePath}`);
  process.exit(1);
}

const source = new Database(sourcePath, { readonly: true });
const target = new Database(targetPath);

target.exec(`
  CREATE TABLE IF NOT EXISTS internet_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    download_speed TEXT NOT NULL DEFAULT '',
    upload_speed TEXT NOT NULL DEFAULT '',
    connection_type TEXT NOT NULL DEFAULT 'outro',
    monthly_price_cve REAL NOT NULL DEFAULT 0,
    installation_fee_cve REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    plan_id INTEGER REFERENCES internet_plans(id),
    monthly_value_cve REAL NOT NULL DEFAULT 0,
    activation_date TEXT,
    due_day INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('active','suspended','cancelled')) DEFAULT 'active',
    ip_address TEXT,
    technical_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    service_id INTEGER NOT NULL REFERENCES services(id),
    reference_month TEXT NOT NULL,
    amount_cve REAL NOT NULL,
    due_date TEXT NOT NULL,
    payment_date TEXT,
    payment_method TEXT CHECK(payment_method IN ('numerario','transferencia','outro')),
    status TEXT NOT NULL CHECK(status IN ('pending','paid','overdue')) DEFAULT 'pending',
    invoice_number TEXT,
    invoice_date TEXT,
    receipt_number TEXT,
    receipt_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(service_id, reference_month)
  );
`);

const importPlans = target.prepare(`
  INSERT INTO internet_plans (
    id, name, download_speed, upload_speed, connection_type, monthly_price_cve,
    installation_fee_cve, active, created_at, updated_at
  )
  VALUES (@id, @name, @download_speed, @upload_speed, @connection_type, @monthly_price_cve,
    @installation_fee_cve, @active, @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    monthly_price_cve = excluded.monthly_price_cve,
    active = excluded.active,
    updated_at = excluded.updated_at
`);

const importServices = target.prepare(`
  INSERT INTO services (
    id, client_id, plan_id, monthly_value_cve, activation_date, due_day,
    status, ip_address, technical_notes, created_at, updated_at
  )
  VALUES (
    @id, @client_id, @plan_id, @monthly_value_cve, @activation_date, @due_day,
    @status, @ip_address, @technical_notes, @created_at, @updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    client_id = excluded.client_id,
    plan_id = excluded.plan_id,
    monthly_value_cve = excluded.monthly_value_cve,
    activation_date = excluded.activation_date,
    due_day = excluded.due_day,
    status = excluded.status,
    ip_address = excluded.ip_address,
    technical_notes = excluded.technical_notes,
    updated_at = excluded.updated_at
`);

const importPayments = target.prepare(`
  INSERT INTO payments (
    id, client_id, service_id, reference_month, amount_cve, due_date,
    payment_date, payment_method, status, invoice_number, invoice_date,
    receipt_number, receipt_date, notes, created_at, updated_at
  )
  VALUES (
    @id, @client_id, @service_id, @reference_month, @amount_cve, @due_date,
    @payment_date, @payment_method, @status, @invoice_number, @invoice_date,
    @receipt_number, @receipt_date, @notes, @created_at, @updated_at
  )
  ON CONFLICT(service_id, reference_month) DO UPDATE SET
    amount_cve = excluded.amount_cve,
    due_date = excluded.due_date,
    payment_date = excluded.payment_date,
    payment_method = excluded.payment_method,
    status = excluded.status,
    invoice_number = excluded.invoice_number,
    invoice_date = excluded.invoice_date,
    receipt_number = excluded.receipt_number,
    receipt_date = excluded.receipt_date,
    notes = excluded.notes,
    updated_at = excluded.updated_at
`);

const plans = source.prepare('SELECT * FROM internet_plans').all();
const services = source.prepare(`
  SELECT id, client_id, plan_id, monthly_value_cve, activation_date, due_day,
    status, ip_address, technical_notes, created_at, updated_at
  FROM services
`).all();
const payments = source.prepare(`
  SELECT id, client_id, service_id, reference_month, amount_cve, due_date,
    payment_date, payment_method, status, invoice_number, invoice_date,
    receipt_number, receipt_date, notes, created_at, updated_at
  FROM payments
`).all();

target.transaction(() => {
  plans.forEach((row) => importPlans.run(row));
  services.forEach((row) => importServices.run(row));
  payments.forEach((row) => importPayments.run(row));
})();

console.log(`Planos importados/atualizados: ${plans.length}`);
console.log(`Servicos importados/atualizados: ${services.length}`);
console.log(`Pagamentos importados/atualizados: ${payments.length}`);

source.close();
target.close();
