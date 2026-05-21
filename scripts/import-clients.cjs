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

fs.mkdirSync(targetDir, { recursive: true });

const source = new Database(sourcePath, { readonly: true });
const target = new Database(targetPath);

target.pragma('journal_mode = WAL');
target.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_code TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    phone TEXT UNIQUE,
    email TEXT,
    nif TEXT UNIQUE,
    address TEXT,
    island TEXT,
    zone TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','suspended','cancelled')) DEFAULT 'active',
    notes TEXT,
    admission_date TEXT,
    default_payment_method TEXT CHECK(default_payment_method IN ('numerario','transferencia','outro')),
    whatsapp_opt_out INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(full_name);
  CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
`);

const sourceClients = source.prepare(`
  SELECT
    client_code,
    full_name,
    phone,
    email,
    nif,
    address,
    island,
    zone,
    status,
    notes,
    admission_date,
    default_payment_method,
    COALESCE(whatsapp_opt_out, 0) AS whatsapp_opt_out,
    created_at,
    updated_at
  FROM clients
  ORDER BY id
`).all();

const insert = target.prepare(`
  INSERT INTO clients (
    client_code,
    full_name,
    phone,
    email,
    nif,
    address,
    island,
    zone,
    status,
    notes,
    admission_date,
    default_payment_method,
    whatsapp_opt_out,
    created_at,
    updated_at
  )
  VALUES (
    @client_code,
    @full_name,
    @phone,
    @email,
    @nif,
    @address,
    @island,
    @zone,
    @status,
    @notes,
    @admission_date,
    @default_payment_method,
    @whatsapp_opt_out,
    @created_at,
    @updated_at
  )
  ON CONFLICT(client_code) DO UPDATE SET
    full_name = excluded.full_name,
    phone = excluded.phone,
    email = excluded.email,
    nif = excluded.nif,
    address = excluded.address,
    island = excluded.island,
    zone = excluded.zone,
    status = excluded.status,
    notes = excluded.notes,
    admission_date = excluded.admission_date,
    default_payment_method = excluded.default_payment_method,
    whatsapp_opt_out = excluded.whatsapp_opt_out,
    updated_at = excluded.updated_at
`);

const runImport = target.transaction((rows) => {
  for (const row of rows) {
    insert.run(row);
  }
});

runImport(sourceClients);

const total = target.prepare('SELECT COUNT(*) AS total FROM clients').get().total;

source.close();
target.close();

console.log(`Clientes importados/atualizados: ${sourceClients.length}`);
console.log(`Total de clientes na nova base: ${total}`);
console.log(`Origem: ${sourcePath}`);
console.log(`Destino: ${targetPath}`);
