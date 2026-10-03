import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { addTicketNote, createTicketWorkOrder, getTicket, listTickets, openTicket, updateTicket } from './support-tickets';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let clientId: number;
let serviceId: number;
let userId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-support-tickets-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  userId = Number(db.prepare("INSERT INTO users (username, password_hash, role, full_name) VALUES ('tec', 'x', 'technician', 'Técnico Um')").run().lastInsertRowid);
});

beforeEach(() => {
  // Filhos primeiro: as OS e as entradas apontam para os pedidos.
  for (const table of ['work_orders', 'support_ticket_entries', 'support_tickets', 'services', 'clients']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  clientId = Number(db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('C001', 'Ana')").run().lastInsertRowid);
  serviceId = Number(db.prepare("INSERT INTO services (client_id, status) VALUES (?, 'active')").run(clientId).lastInsertRowid);
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

const open = (extra: Partial<Parameters<typeof openTicket>[1]> = {}) => {
  const result = openTicket(db, {
    clientId, serviceId, subject: 'Sem internet desde ontem', channel: 'telefone', category: 'sem_ligacao', note: 'Cliente ligou às 9h', ...extra
  }, userId);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe('pedidos de assistência', () => {
  test('abrir guarda o relato como primeira entrada, sem contar como resposta', () => {
    const id = open();
    const ticket = getTicket(db, id)!;
    expect(ticket).toMatchObject({ status: 'aberto', priority: 'media', clientCode: 'C001', openedByName: 'Técnico Um', firstResponseAt: null });
    expect(ticket.entries).toEqual([expect.objectContaining({ kind: 'nota', body: 'Cliente ligou às 9h', authorName: 'Técnico Um' })]);
  });

  test('recusa cliente inexistente e serviço de outro cliente', () => {
    expect(openTicket(db, { clientId: 999_999, subject: 'x', channel: 'outro', category: 'outro', note: 'x' }, userId))
      .toMatchObject({ ok: false, status: 400 });
    const other = Number(db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('C002', 'Bruno')").run().lastInsertRowid);
    expect(openTicket(db, { clientId: other, serviceId, subject: 'x', channel: 'outro', category: 'outro', note: 'x' }, userId))
      .toMatchObject({ ok: false, error: 'O serviço não é deste cliente' });
  });

  test('a primeira nota marca a primeira resposta, e só a primeira', () => {
    const id = open();
    addTicketNote(db, id, 'Pedi para reiniciar a antena', userId);
    const first = getTicket(db, id)!.firstResponseAt;
    expect(first).not.toBeNull();
    addTicketNote(db, id, 'Continua sem sinal', userId);
    expect(getTicket(db, id)!.firstResponseAt).toBe(first);
  });

  test('resolver sem nota recusa; com nota guarda a data e deixa a mudança no histórico', () => {
    const id = open();
    expect(updateTicket(db, id, { status: 'resolvido' }, userId)).toMatchObject({ ok: false, status: 400 });
    expect(updateTicket(db, id, { status: 'resolvido', note: 'Trocado o conector RJ45' }, userId).ok).toBe(true);
    const ticket = getTicket(db, id)!;
    expect(ticket.status).toBe('resolvido');
    expect(ticket.resolvedAt).not.toBeNull();
    expect(ticket.entries.map((entry) => (entry as { body: string }).body)).toEqual(['Cliente ligou às 9h', 'Aberto → Resolvido', 'Trocado o conector RJ45']);
  });

  test('reabrir apaga as datas de fim', () => {
    const id = open();
    updateTicket(db, id, { status: 'fechado', note: 'Resolvido no local' }, userId);
    expect(getTicket(db, id)).toMatchObject({ resolvedAt: expect.any(String), closedAt: expect.any(String) });
    updateTicket(db, id, { status: 'aberto' }, userId);
    expect(getTicket(db, id)).toMatchObject({ status: 'aberto', resolvedAt: null, closedAt: null });
  });

  test('criar OS liga-a ao pedido, com o serviço e tipo manutenção', () => {
    const id = open({ priority: 'alta' });
    const result = createTicketWorkOrder(db, id, { assignedTo: 'Técnico Um', scheduledAt: '2026-10-04 09:00' }, userId);
    expect(result.ok).toBe(true);
    const ticket = getTicket(db, id)!;
    expect(ticket.workOrders).toEqual([expect.objectContaining({ title: 'Sem internet desde ontem', status: 'agendada', assignedTo: 'Técnico Um' })]);
    const order = db.prepare('SELECT service_id AS serviceId, event_type AS eventType, priority, ticket_id AS ticketId FROM work_orders').get();
    expect(order).toEqual({ serviceId, eventType: 'manutencao', priority: 'alta', ticketId: id });
    expect(ticket.entries.at(-1)).toMatchObject({ kind: 'os_criada' });
  });

  test('a lista põe os abertos primeiro e conta o painel', () => {
    const resolved = open({ subject: 'Antigo' });
    updateTicket(db, resolved, { status: 'resolvido', note: 'feito' }, userId);
    open({ subject: 'Novo' });
    const waiting = open({ subject: 'Espera' });
    updateTicket(db, waiting, { status: 'aguarda_cliente' }, userId);
    const { items, metrics } = listTickets(db);
    expect(items.at(-1)?.subject).toBe('Antigo');
    expect(metrics).toMatchObject({ open: 1, waiting: 1, resolvedThisMonth: 1 });
    expect(listTickets(db, { status: 'aguarda_cliente' }).items.map((row) => row.subject)).toEqual(['Espera']);
  });
});
