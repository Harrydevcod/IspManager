/**
 * O estado de um serviço só muda por uma porta, e a passagem fica escrita.
 *
 * Antes o estado era mais um campo do formulário: um serviço passava a suspenso
 * sem data, sem motivo e sem aparecer na história do cliente. É esse registo que
 * um futuro controlo de acesso na rede vai ler (ADR 0007), e por isso é o que
 * estes testes protegem.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let services: typeof import('./services');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-service-status-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // corre as migrações
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  services = await import('./services');
});

beforeEach(() => {
  db.prepare('DELETE FROM service_events').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function seedService(status = 'active'): number {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES ('CLI-001', 'Ana Silva', 'active')
  `).run().lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 2500, 10, ?)
  `).run(clientId, status).lastInsertRowid as number;
}

function eventsOf(serviceId: number) {
  return db.prepare(`
    SELECT event_type AS eventType, notes FROM service_events WHERE service_id = ? ORDER BY id
  `).all(serviceId) as Array<{ eventType: string; notes: string | null }>;
}

describe('changeServiceStatus', () => {
  test('suspender escreve a transição com o motivo', () => {
    const id = seedService();
    const result = services.changeServiceStatus(db, id, 'suspended', { reason: 'Dívida de dois meses' });

    expect(result.ok && result.value).toEqual({ changed: true, previous: 'active', next: 'suspended' });
    expect(db.prepare('SELECT status FROM services WHERE id = ?').get(id)).toEqual({ status: 'suspended' });
    expect(eventsOf(id)).toEqual([{ eventType: 'suspensao', notes: 'Dívida de dois meses' }]);
  });

  test('reativar e cancelar têm cada um o seu tipo de evento', () => {
    const id = seedService('suspended');
    services.changeServiceStatus(db, id, 'active', { reason: 'Pagou' });
    services.changeServiceStatus(db, id, 'cancelled', { reason: 'Mudou-se' });

    expect(eventsOf(id).map((event) => event.eventType)).toEqual(['reativacao', 'cancelamento']);
  });

  test('mudar para o estado que já tem não inventa história', () => {
    const id = seedService('suspended');
    const result = services.changeServiceStatus(db, id, 'suspended', { reason: 'Outra vez' });

    expect(result.ok && result.value.changed).toBe(false);
    expect(eventsOf(id)).toHaveLength(0);
  });

  test('um serviço que não existe é 404, não uma escrita silenciosa', () => {
    const result = services.changeServiceStatus(db, 9999, 'suspended', {});
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_events').get()).toEqual({ n: 0 });
  });

  test('um motivo em branco fica nulo, não uma string vazia', () => {
    const id = seedService();
    services.changeServiceStatus(db, id, 'suspended', { reason: '   ' });
    expect(eventsOf(id)[0].notes).toBeNull();
  });
});

describe('updateService', () => {
  const payload = {
    clientId: 0,
    planId: null,
    monthlyValueCve: 2500,
    dueDay: 10,
    activationDate: null,
    status: 'suspended' as const,
    technicalNotes: null,
    audiovisualMode: 'none' as const,
    audiovisualMonthlyCve: 0,
    audiovisualAnnualCve: 0,
    items: null,
    installCosts: null
  };

  test('gravar o formulário com outro estado passa pela mesma porta', () => {
    const id = seedService();
    const clientId = Number((db.prepare('SELECT client_id AS id FROM services WHERE id = ?').get(id) as { id: number }).id);

    const result = services.updateService(db, id, { ...payload, clientId });

    expect(result.ok).toBe(true);
    expect(eventsOf(id)).toEqual([{ eventType: 'suspensao', notes: 'Alteração no formulário do serviço' }]);
  });

  test('gravar o formulário sem mexer no estado não gera evento', () => {
    const id = seedService();
    const clientId = Number((db.prepare('SELECT client_id AS id FROM services WHERE id = ?').get(id) as { id: number }).id);

    services.updateService(db, id, { ...payload, clientId, status: 'active', monthlyValueCve: 3000 });

    expect(eventsOf(id)).toHaveLength(0);
    expect(db.prepare('SELECT monthly_value_cve AS value FROM services WHERE id = ?').get(id)).toEqual({ value: 3000 });
  });
});
