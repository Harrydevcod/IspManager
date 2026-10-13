import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { insertClient } from './client-records';

let db: Database.Database;
beforeAll(() => { db = new Database(':memory:'); runMigrations(db); });
beforeEach(() => { db.prepare('DELETE FROM clients').run(); });
afterAll(() => { db.close(); });

test('preserva os dados do cadastro e atribui um código de cliente', () => {
  const id = insertClient(db, { fullName: 'Loja do Porto', phone: '9911122', nif: '250000001',
    island: 'São Vicente', zone: 'Centro', address: 'Rua 1', status: 'suspended' });
  expect(db.prepare(`SELECT client_code AS code, full_name AS name, phone, nif, island, zone, address, status
    FROM clients WHERE id = ?`).get(id)).toEqual({ code: 'C0001', name: 'Loja do Porto', phone: '9911122',
    nif: '250000001', island: 'São Vicente', zone: 'Centro', address: 'Rua 1', status: 'suspended' });
});

test('um destinatário mínimo fica ativo, sem serviço e com campos opcionais nulos', () => {
  const id = insertClient(db, { fullName: 'Destinatário' });
  expect(db.prepare('SELECT phone, nif, island, zone, address, status FROM clients WHERE id = ?').get(id))
    .toEqual({ phone: null, nif: null, island: null, zone: null, address: null, status: 'active' });
  expect(db.prepare('SELECT count(*) AS n FROM services WHERE client_id = ?').get(id)).toEqual({ n: 0 });
});

test('não reutiliza um código ocupado depois de apagar um cliente', () => {
  const first = insertClient(db, { fullName: 'Primeiro' });
  insertClient(db, { fullName: 'Segundo' });
  db.prepare('DELETE FROM clients WHERE id = ?').run(first);
  const id = insertClient(db, { fullName: 'Terceiro' });
  expect(db.prepare('SELECT client_code AS code FROM clients WHERE id = ?').get(id)).toEqual({ code: 'C0003' });
});

test('participa na transação da fatura: um erro posterior não deixa o cliente criado', () => {
  expect(() => db.transaction(() => {
    insertClient(db, { fullName: 'Destinatário' });
    throw new Error('A emissão falhou');
  })()).toThrow('A emissão falhou');
  expect(db.prepare('SELECT count(*) AS n FROM clients').get()).toEqual({ n: 0 });
});
