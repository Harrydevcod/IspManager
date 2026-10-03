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
let clientId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-tickets-routes-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_AUTH = 'off';
  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of ['work_orders', 'support_ticket_entries', 'support_tickets', 'services', 'clients']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  clientId = Number(db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('C001', 'Ana')").run().lastInsertRowid);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

const body = { subject: 'Internet lenta', channel: 'whatsapp', category: 'lento', note: 'À noite fica lenta' };

describe('pedidos de assistência pela API', () => {
  test('abrir, acrescentar nota, criar OS e resolver', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/tickets', payload: { clientId, ...body } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;

    const noted = await app.inject({ method: 'POST', url: `/api/tickets/${id}/entries`, payload: { body: 'Vou passar amanhã' } });
    expect(noted.json().entries).toHaveLength(2);

    const withOrder = await app.inject({ method: 'POST', url: `/api/tickets/${id}/work-orders`, payload: {} });
    expect(withOrder.statusCode).toBe(201);
    expect(withOrder.json().workOrders).toHaveLength(1);
    const order = await app.inject(`/api/work-orders/${withOrder.json().workOrders[0].id}`);
    expect(order.json().ticketId).toBe(id);

    const unresolved = await app.inject({ method: 'PATCH', url: `/api/tickets/${id}`, payload: { status: 'resolvido' } });
    expect(unresolved.statusCode).toBe(400);
    const resolved = await app.inject({ method: 'PATCH', url: `/api/tickets/${id}`, payload: { status: 'resolvido', note: 'Antena realinhada' } });
    expect(resolved.json().status).toBe('resolvido');

    const list = await app.inject('/api/tickets?status=resolvido');
    expect(list.json().items.map((row: { id: number }) => row.id)).toEqual([id]);
  });

  test('valida o que entra e responde 404 ao que não existe', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/tickets', payload: { clientId, ...body, channel: 'pombo' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/tickets', payload: { clientId, ...body, subject: ' ' } })).json().error).toBe('Indique o assunto');
    expect((await app.inject('/api/tickets/999')).statusCode).toBe(404);
    expect((await app.inject('/api/tickets/abc')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/tickets/999/entries', payload: { body: 'x' } })).statusCode).toBe(404);
    expect((await app.inject('/api/tickets?status=perdido')).statusCode).toBe(400);
  });

  test('a lista de técnicos traz só os utilizadores ativos', async () => {
    db.prepare("INSERT INTO users (username, password_hash, role, full_name, active) VALUES ('a', 'x', 'technician', 'Ativo', 1), ('b', 'x', 'technician', 'Inativo', 0)").run();
    const names = (await app.inject('/api/tickets/assignees')).json().map((row: { fullName: string }) => row.fullName);
    expect(names).toContain('Ativo');
    expect(names).not.toContain('Inativo');
  });
});
