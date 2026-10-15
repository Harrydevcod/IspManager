import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { runMigrations } from '../migrate';
import { migrations } from '.';

let db: Database.Database;
afterEach(() => db?.close());

test('0086 dá código ao equipamento e aos planos existentes e muda o Cliente Indiferenciado para VD', () => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  runMigrations(db, migrations.filter((migration) => migration.version < 86));
  db.prepare("INSERT INTO equipment_catalog(type,model) VALUES ('cpe','A'),('cpe','B')").run();
  db.prepare("INSERT INTO internet_plans(name) VALUES ('Base')").run();
  runMigrations(db); runMigrations(db);
  expect(db.prepare('SELECT code FROM equipment_catalog ORDER BY id').all()).toEqual([{ code: 'EQP0001' }, { code: 'EQP0002' }]);
  expect(db.prepare('SELECT code FROM internet_plans').all()).toEqual([{ code: 'PLN0001' }]);
  expect(db.prepare("SELECT client_code,full_name FROM clients WHERE system_kind='indifferentiated'").get())
    .toEqual({ client_code: 'VD', full_name: 'Cliente Indiferenciado' });
  expect(() => db.prepare("UPDATE equipment_catalog SET code='eqp0001' WHERE id=2").run()).toThrow(/UNIQUE/);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  const columns = (table: string) => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
  expect(columns('payment_lines')).toContain('article_id');
  expect(columns('proposal_lines')).toEqual(expect.arrayContaining(['article_id', 'item_code']));
  expect(columns('payment_lines')).toEqual(expect.arrayContaining(['item_code', 'item_note', 'quantity']));
  expect(columns('proposal_lines')).toContain('item_note');
  expect(columns('articles')).toContain('document_note');
  expect(columns('equipment_catalog')).toContain('document_note');
});

test('0086 não rouba o código VD a um cliente real', () => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  runMigrations(db, migrations.filter((migration) => migration.version < 86));
  db.prepare("INSERT INTO clients(client_code,full_name) VALUES ('VD','Vitor Delgado')").run();
  runMigrations(db);
  expect(db.prepare("SELECT client_code FROM clients WHERE system_kind='indifferentiated'").get()).toEqual({ client_code: 'INDIF' });
  expect(db.prepare("SELECT full_name FROM clients WHERE client_code='VD'").get()).toEqual({ full_name: 'Vitor Delgado' });
});

test('artigos: código único sem distinguir maiúsculas e nome único entre ativos', () => {
  db = new Database(':memory:'); runMigrations(db);
  const insert = db.prepare('INSERT INTO articles(code,name,kind,active) VALUES (?,?,?,?)');
  insert.run('SRV0001', 'Deslocação técnica', 'service', 1);
  expect(() => insert.run('srv0001', 'Outro', 'service', 1)).toThrow(/UNIQUE/);
  expect(() => insert.run('SRV0002', 'deslocação técnica', 'service', 1)).toThrow(/UNIQUE/);
  insert.run('SRV0003', 'Deslocação técnica', 'service', 0);
  expect(() => insert.run('X1', 'Y', 'bundle', 1)).toThrow(/CHECK/);
});
