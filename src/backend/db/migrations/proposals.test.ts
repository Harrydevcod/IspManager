import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { runMigrations } from '../migrate';
import { migrations } from '.';
let db: Database.Database;
afterEach(()=>db?.close());
test('base nova e execução repetida preservam integridade de propostas',()=>{
    db=new Database(':memory:');db.pragma('foreign_keys=ON');runMigrations(db);runMigrations(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'proposal%'").all()).toHaveLength(4);
    expect(db.pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);expect(db.pragma('foreign_key_check')).toEqual([]);
});
test('upgrade83 preserva faturas, TV, linhas, recebimentos e sequências fiscais',()=>{
    db=new Database(':memory:');db.pragma('foreign_keys=ON');runMigrations(db,migrations.filter(m=>m.version<=83));
    const client=Number(db.prepare("INSERT INTO clients(client_code,full_name) VALUES ('TEST','Cliente')").run().lastInsertRowid);
    for(const [type,number] of [['invoice','FT-2026-00001'],['sale_ticket','TV-2026-00001']]) {
        const payment=Number(db.prepare("INSERT INTO payments(client_id,reference_month,amount_cve,due_date,invoice_number,status,document_type) VALUES (?, ?,100,'2026-10-01',?,'paid',?)").run(client,number,number,type).lastInsertRowid);
        db.prepare("INSERT INTO payment_lines(payment_id,kind,description,amount_cve) VALUES (?,'avulso','Linha',100)").run(payment);
        db.prepare("INSERT INTO payment_receipts(payment_id,amount_cve,payment_date,payment_method,receipt_number,receipt_date) VALUES (?,100,'2026-10-01','numerario',?,'2026-10-01')").run(payment,`RC-${payment}`);
    }
    db.prepare("INSERT INTO document_sequences(series,year,last_number) VALUES ('PR',2026,42)").run();
    const tables=['payments','payment_lines','payment_receipts','document_sequences'];const before=tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all());
    runMigrations(db);runMigrations(db);expect(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(db.prepare('SELECT * FROM proposal_sequences').all()).toEqual([]);expect(db.pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);expect(db.pragma('foreign_key_check')).toEqual([]);
});

test('upgrade84 keeps issued proposal content and historical PR sequence unchanged',()=>{
  db=new Database(':memory:');runMigrations(db,migrations.filter(m=>m.version<=84));
  db.prepare("INSERT INTO proposals(number,recipient_json,title,valid_until,conditions,status,once_total_centavos,monthly_total_centavos,snapshot_json) VALUES ('PR-2026-00042','{}','Oferta','2099-01-01','Termos','issued',100,200,'{}')").run();
  db.prepare('INSERT INTO proposal_sequences VALUES (2026,42)').run();
  const before=db.prepare('SELECT * FROM proposals').get() as Record<string,unknown>;
  runMigrations(db);runMigrations(db);
  expect(db.prepare('SELECT * FROM proposals').get()).toEqual({...before,document_type:'proposal',payment_request_json:null});
  expect(db.prepare('SELECT * FROM proposal_sequences').all()).toEqual([{year:2026,last_number:42}]);
  expect(db.prepare('SELECT * FROM quotation_sequences').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM proforma_sequences').all()).toEqual([]);
});
