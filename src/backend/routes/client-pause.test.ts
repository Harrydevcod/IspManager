/**
 * Pausa a pedido do cliente: uma ausência temporária (férias, viagem) é uma
 * suspensão com origem `client_request` e data de regresso opcional.
 *
 * A faturação de um suspenso (só o aluguer) já está fixada em
 * `billing.rental.test.ts` e não depende da origem. Aqui protege-se o que é
 * próprio da pausa: a data, o regresso sozinho, e que pagar não a desfaz.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { businessDay } from '../../shared/business-day';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let suspension: typeof import('../lib/auto-suspension');

const DAY_MS = 86_400_000;
const tomorrow = () => businessDay(Date.now() + DAY_MS);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-client-pause-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  suspension = await import('../lib/auto-suspension');
});

beforeEach(() => {
  db.exec(`
    DELETE FROM service_events;
    DELETE FROM services;
    DELETE FROM clients;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

let seq = 0;
function seedService(clientStatus = 'active'): number {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, 'Bruna Delgado', ?)
  `).run(`CLI-${++seq}`, clientStatus).lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 2500, 10, 'active')
  `).run(clientId).lastInsertRowid as number;
}

function serviceOf(id: number) {
  return db.prepare(`
    SELECT status, suspension_source AS source, pause_until AS pauseUntil FROM services WHERE id = ?
  `).get(id) as { status: string; source: string | null; pauseUntil: string | null };
}

function pause(id: number, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/services/${id}/status`, payload: { status: 'suspended', ...body } });
}

describe('POST /api/services/:id/status — pausa a pedido do cliente', () => {
  test('grava a origem, a data e o evento com o motivo', async () => {
    const id = seedService();
    const until = tomorrow();
    const response = await pause(id, { source: 'client_request', pauseUntil: until });

    expect(response.statusCode).toBe(200);
    expect(serviceOf(id)).toEqual({ status: 'suspended', source: 'client_request', pauseUntil: until });
    const event = db.prepare(`SELECT event_type AS type, notes FROM service_events WHERE service_id = ?`).get(id);
    expect(event).toEqual({ type: 'suspensao', notes: `Ausência a pedido do cliente até ${until}` });
  });

  test('sem data a pausa fica aberta', async () => {
    const id = seedService();
    expect((await pause(id, { source: 'client_request' })).statusCode).toBe(200);
    expect(serviceOf(id)).toEqual({ status: 'suspended', source: 'client_request', pauseUntil: null });
  });

  test('rejeita data de hoje ou do passado', async () => {
    const id = seedService();
    expect((await pause(id, { source: 'client_request', pauseUntil: businessDay() })).statusCode).toBe(400);
    expect(serviceOf(id).status).toBe('active');
  });

  test('rejeita data de regresso numa suspensão pelo operador', async () => {
    const id = seedService();
    expect((await pause(id, { source: 'manual', pauseUntil: tomorrow() })).statusCode).toBe(400);
    expect(serviceOf(id).status).toBe('active');
  });

  test('a cobrança não entra por esta porta', async () => {
    const id = seedService();
    expect((await pause(id, { source: 'nonpayment' })).statusCode).toBe(400);
  });

  test('num serviço já em pausa, muda só o regresso', async () => {
    const id = seedService();
    await pause(id, { source: 'client_request', pauseUntil: tomorrow() });
    const later = businessDay(Date.now() + 30 * DAY_MS);
    const response = await pause(id, { source: 'client_request', pauseUntil: later });

    expect(response.json()).toMatchObject({ changed: true });
    expect(serviceOf(id)).toEqual({ status: 'suspended', source: 'client_request', pauseUntil: later });
  });

  test('reativar à mão fecha a pausa e limpa a data', async () => {
    const id = seedService();
    await pause(id, { source: 'client_request', pauseUntil: tomorrow() });
    await app.inject({ method: 'POST', url: `/api/services/${id}/status`, payload: { status: 'active' } });
    expect(serviceOf(id)).toEqual({ status: 'active', source: null, pauseUntil: null });
  });

  test('a lista devolve a origem e o regresso', async () => {
    const id = seedService();
    const until = tomorrow();
    await pause(id, { source: 'client_request', pauseUntil: until });
    const rows = (await app.inject({ method: 'GET', url: '/api/services' })).json() as Array<{ id: number; suspensionSource: string; pauseUntil: string }>;
    expect(rows.find((row) => row.id === id)).toMatchObject({ suspensionSource: 'client_request', pauseUntil: until });
  });
});

describe('resumeDuePauses', () => {
  test('no dia de regresso reativa; na véspera não', async () => {
    const id = seedService();
    await pause(id, { source: 'client_request', pauseUntil: tomorrow() });

    expect(suspension.resumeDuePauses(db, new Date())).toEqual([]);
    expect(serviceOf(id).status).toBe('suspended');

    expect(suspension.resumeDuePauses(db, new Date(Date.now() + DAY_MS))).toEqual([id]);
    expect(serviceOf(id)).toEqual({ status: 'active', source: null, pauseUntil: null });
  });

  test('pausa sem data e suspensão pelo operador ficam como estão', async () => {
    const open = seedService();
    await pause(open, { source: 'client_request' });
    const manual = seedService();
    await pause(manual, { source: 'manual' });

    expect(suspension.resumeDuePauses(db, new Date(Date.now() + 365 * DAY_MS))).toEqual([]);
  });

  test('cliente que deixou de estar ativo não volta sozinho', async () => {
    const id = seedService();
    await pause(id, { source: 'client_request', pauseUntil: tomorrow() });
    db.prepare(`UPDATE clients SET status = 'cancelled'`).run();
    expect(suspension.resumeDuePauses(db, new Date(Date.now() + DAY_MS))).toEqual([]);
  });
});

test('pagar durante a pausa não reativa o serviço', async () => {
  const id = seedService();
  await pause(id, { source: 'client_request', pauseUntil: tomorrow() });
  expect(suspension.reactivateServiceIfEligibleAfterPayment(db, id)).toBe(false);
  expect(serviceOf(id).status).toBe('suspended');
});
