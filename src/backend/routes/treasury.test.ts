/**
 * Tesouraria pela API: as portas que o ecrã usa, e as despesas e investimentos
 * a tirar dinheiro da conta que o operador indicou.
 */
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-treasury-routes-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.exec(`
    DELETE FROM treasury_movements;
    DELETE FROM expenses;
    DELETE FROM investment_items;
    DELETE FROM investments;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

type Account = { id: number; name: string; kind: string; balanceCve: number; isDefaultCash: boolean };

async function accounts(): Promise<Account[]> {
  return (await app.inject({ method: 'GET', url: '/api/treasury/accounts' })).json();
}

async function newBank(name: string, openingBalanceCve = 0) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/treasury/accounts',
    payload: { kind: 'banco', name, bankName: name, accountNumber: '0001', openingBalanceCve, openingDate: '2026-01-01' }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Account;
}

const balanceOf = async (id: number) => (await accounts()).find((a) => a.id === id)!.balanceCve;

describe('contas', () => {
  test('a base nasce com a caixa principal predefinida', async () => {
    const caixa = (await accounts()).find((a) => a.isDefaultCash);
    expect(caixa).toMatchObject({ kind: 'caixa', name: 'Caixa principal' });
  });

  test('conta com dados invalidos da 400', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/treasury/accounts', payload: { kind: 'cofre', name: '' } });
    expect(response.statusCode).toBe(400);
  });
});

describe('despesas pagas por uma conta', () => {
  test('criar tira o dinheiro, corrigir o valor acerta, apagar devolve', async () => {
    const bank = await newBank('BCA despesas', 100000);

    const create = await app.inject({
      method: 'POST',
      url: '/api/expenses',
      payload: { category: 'energia', description: 'Electra julho', amountCve: 7000, expenseDate: '2026-07-05', accountId: bank.id }
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: number };
    expect(await balanceOf(bank.id)).toBe(93000);

    const list = (await app.inject({ method: 'GET', url: '/api/expenses' })).json() as { rows: Array<{ id: number; accountName: string }> };
    expect(list.rows.find((r) => r.id === id)?.accountName).toBe('BCA despesas');

    await app.inject({
      method: 'PUT',
      url: `/api/expenses/${id}`,
      payload: { category: 'energia', description: 'Electra julho', amountCve: 7500, expenseDate: '2026-07-05', accountId: bank.id }
    });
    expect(await balanceOf(bank.id)).toBe(92500);

    const remove = await app.inject({ method: 'DELETE', url: `/api/expenses/${id}` });
    expect(remove.statusCode).toBe(200);
    expect(await balanceOf(bank.id)).toBe(100000);
  });

  test('conta inexistente recusa a despesa sem a gravar', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/expenses',
      payload: { category: 'energia', description: 'Sem conta', amountCve: 100, expenseDate: '2026-07-05', accountId: 99999 }
    });
    expect(response.statusCode).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number }).n).toBe(0);
  });
});

describe('investimentos pagos por uma conta', () => {
  test('so sai da conta o custo externo, nao o equipamento do catalogo', async () => {
    const bank = await newBank('BCA capex', 500000);
    const catalogId = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model) VALUES ('equipamento', 'cpe', 'TP-Link', 'CPE Tesouraria')
    `).run().lastInsertRowid as number;

    const response = await app.inject({
      method: 'POST',
      url: '/api/investments',
      payload: {
        name: 'Expansao Achada',
        investmentDate: '2026-07-01',
        accountId: bank.id,
        items: [
          { itemType: 'cpe', itemName: 'CPE Tesouraria', quantity: 2, unitCostCve: 9000, catalogId },
          { itemType: 'mao_obra', itemName: 'Instalacao', quantity: 1, unitCostCve: 15000 }
        ]
      }
    });
    expect(response.statusCode).toBe(201);
    expect(await balanceOf(bank.id)).toBe(485000);
  });
});

describe('deposito, contagem e resumo', () => {
  test('deposito move o dinheiro sem contar como entrada nem saida do mes', async () => {
    const bank = await newBank('BCA deposito');
    const caixa = (await accounts()).find((a) => a.isDefaultCash)!;
    await app.inject({ method: 'PATCH', url: `/api/treasury/accounts/${caixa.id}`, payload: { openingBalanceCve: 20000, openingDate: '2026-01-01' } });

    const deposit = await app.inject({
      method: 'POST',
      url: '/api/treasury/transfers',
      payload: { fromAccountId: caixa.id, toAccountId: bank.id, amountCve: 15000, reference: 'Talao 12' }
    });
    expect(deposit.statusCode).toBe(201);
    expect(deposit.json().kind).toBe('deposito');

    const summary = (await app.inject({ method: 'GET', url: '/api/treasury/summary' })).json();
    expect(summary.monthInCve).toBe(0);
    expect(summary.monthOutCve).toBe(0);
    expect(await balanceOf(caixa.id)).toBe(5000);

    const count = await app.inject({ method: 'POST', url: '/api/treasury/counts', payload: { accountId: caixa.id, countedCve: 5000 } });
    expect(count.json().differenceCve).toBe(0);

    const movements = (await app.inject({ method: 'GET', url: `/api/treasury/movements?accountId=${bank.id}` })).json();
    expect(movements[0]).toMatchObject({ kind: 'deposito', direction: 'in', reference: 'Talao 12', balanceAfterCve: 15000 });
  });

  test('deposito sem saldo da 409', async () => {
    const bank = await newBank('BCA sem saldo');
    const vazia = await app.inject({ method: 'POST', url: '/api/treasury/accounts', payload: { kind: 'caixa', name: 'Caixa vazia' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/treasury/transfers',
      payload: { fromAccountId: vazia.json().id, toAccountId: bank.id, amountCve: 1 }
    });
    expect(response.statusCode).toBe(409);
  });
});
