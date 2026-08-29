import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let generateMonthlyBilling: typeof import('./billing').generateMonthlyBilling;
let runAudiovisualAnnualIfDue: typeof import('./audiovisual-billing').runAudiovisualAnnualIfDue;

const AV_LABEL = 'Distribuição de Conteúdos Audiovisuais';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-av-billing-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // run migrations
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  ({ generateMonthlyBilling } = await import('./billing'));
  ({ runAudiovisualAnnualIfDue } = await import('./audiovisual-billing'));
});

beforeEach(() => {
  // Child-first: payment_lines → payments → services → clients.
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payment_lines').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function seedClient(code: string, status: 'active' | 'cancelled' = 'active'): number {
  return db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, ?)`)
    .run(code, `Cliente ${code}`, status).lastInsertRowid as number;
}

function seedService(clientId: number, opts: {
  monthly?: number;
  avMode?: 'none' | 'monthly' | 'annual';
  avMonthly?: number;
  avAnnual?: number;
  activation?: string | null;
}): number {
  return db.prepare(`
    INSERT INTO services (
      client_id, monthly_value_cve, due_day, status, activation_date,
      audiovisual_mode, audiovisual_monthly_cve, audiovisual_annual_cve
    )
    VALUES (?, ?, 1, 'active', ?, ?, ?, ?)
  `).run(
    clientId,
    opts.monthly ?? 0,
    opts.activation ?? null,
    opts.avMode ?? 'none',
    opts.avMonthly ?? 0,
    opts.avAnnual ?? 0
  ).lastInsertRowid as number;
}

const linesFor = (serviceId: number) =>
  db.prepare(`
    SELECT pl.kind AS kind, pl.description AS description, pl.amount_cve AS amountCve
    FROM payment_lines pl
    JOIN payments p ON p.id = pl.payment_id
    WHERE p.service_id = ?
    ORDER BY pl.sort_order
  `).all(serviceId) as Array<{ kind: string; description: string; amountCve: number }>;

const paymentsFor = (serviceId: number) =>
  db.prepare('SELECT reference_month AS ref, amount_cve AS amount FROM payments WHERE service_id = ? ORDER BY ref')
    .all(serviceId) as Array<{ ref: string; amount: number }>;

describe('audiovisual mensal — combinado na fatura da internet', () => {
  test('internet + audiovisual mensal → uma fatura com duas linhas e total somado', () => {
    const svc = seedService(seedClient('A'), { monthly: 2500, avMode: 'monthly', avMonthly: 500 });

    generateMonthlyBilling(db, '2026-06');

    expect(paymentsFor(svc)).toEqual([{ ref: '2026-06', amount: 3000 }]);
    expect(linesFor(svc)).toEqual([
      { kind: 'internet', description: 'Servico de Internet', amountCve: 2500 },
      { kind: 'audiovisual', description: AV_LABEL, amountCve: 500 }
    ]);
  });

  test('audiovisual standalone mensal (sem internet) → fatura só com a linha audiovisual', () => {
    const svc = seedService(seedClient('B'), { monthly: 0, avMode: 'monthly', avMonthly: 500 });

    generateMonthlyBilling(db, '2026-06');

    expect(paymentsFor(svc)).toEqual([{ ref: '2026-06', amount: 500 }]);
    expect(linesFor(svc)).toEqual([
      { kind: 'audiovisual', description: AV_LABEL, amountCve: 500 }
    ]);
  });

  test('serviço sem valor mensal (anual ou nada) não gera fatura mensal vazia', () => {
    const standaloneAnnual = seedService(seedClient('C'), { monthly: 0, avMode: 'annual', avAnnual: 5000, activation: '2026-06-10' });
    const empty = seedService(seedClient('D'), { monthly: 0, avMode: 'none' });

    generateMonthlyBilling(db, '2026-06');

    expect(paymentsFor(standaloneAnnual)).toEqual([]);
    expect(paymentsFor(empty)).toEqual([]);
  });

  test('serviço internet + audiovisual anual → mensal só fatura a internet (anuidade vai à parte)', () => {
    const svc = seedService(seedClient('E'), { monthly: 2500, avMode: 'annual', avAnnual: 5000, activation: '2026-06-10' });

    generateMonthlyBilling(db, '2026-06');

    expect(paymentsFor(svc)).toEqual([{ ref: '2026-06', amount: 2500 }]);
    expect(linesFor(svc)).toEqual([
      { kind: 'internet', description: 'Servico de Internet', amountCve: 2500 }
    ]);
  });
});

describe('audiovisual anual — fatura separada e idempotente', () => {
  test('gera a fatura anual do ciclo corrente com uma linha audiovisual', () => {
    const svc = seedService(seedClient('A'), { avMode: 'annual', avAnnual: 5000, activation: '2026-06-15' });

    const result = runAudiovisualAnnualIfDue(new Date(2026, 5, 20)); // 20 Jun 2026

    expect(result).toMatchObject({ ran: true, created: 1, references: ['AV-2026-06'] });
    expect(paymentsFor(svc)).toEqual([{ ref: 'AV-2026-06', amount: 5000 }]);
    expect(linesFor(svc)).toEqual([
      { kind: 'audiovisual', description: AV_LABEL, amountCve: 5000 }
    ]);
  });

  test('idempotente — segunda corrida no mesmo ciclo não duplica', () => {
    const svc = seedService(seedClient('A'), { avMode: 'annual', avAnnual: 5000, activation: '2026-06-15' });

    runAudiovisualAnnualIfDue(new Date(2026, 5, 20));
    const second = runAudiovisualAnnualIfDue(new Date(2026, 5, 25));

    expect(second).toMatchObject({ skipped: true });
    expect(paymentsFor(svc)).toHaveLength(1);
  });

  test('renovação — novo ciclo no ano seguinte gera nova fatura', () => {
    const svc = seedService(seedClient('A'), { avMode: 'annual', avAnnual: 5000, activation: '2026-06-15' });

    runAudiovisualAnnualIfDue(new Date(2026, 5, 20)); // ciclo 2026
    const renewal = runAudiovisualAnnualIfDue(new Date(2027, 5, 20)); // ciclo 2027

    expect(renewal).toMatchObject({ ran: true, references: ['AV-2027-06'] });
    expect(paymentsFor(svc).map((p) => p.ref)).toEqual(['AV-2026-06', 'AV-2027-06']);
  });

  test('antes do aniversário o ciclo corrente começou no ano anterior', () => {
    const svc = seedService(seedClient('A'), { avMode: 'annual', avAnnual: 5000, activation: '2026-06-15' });

    // 1 Mar 2027: ainda não chegou ao aniversário (15 Jun) → ciclo começou em 2026
    runAudiovisualAnnualIfDue(new Date(2027, 2, 1));

    expect(paymentsFor(svc)).toEqual([{ ref: 'AV-2026-06', amount: 5000 }]);
  });

  test('cliente cancelado nunca é faturado', () => {
    const cancelled = seedService(seedClient('NOK', 'cancelled'), { avMode: 'annual', avAnnual: 5000, activation: '2026-06-15' });

    const result = runAudiovisualAnnualIfDue(new Date(2026, 5, 20));

    expect(result).toMatchObject({ skipped: true });
    expect(paymentsFor(cancelled)).toEqual([]);
  });

  test('onlyServiceId restringe a geração ao serviço da adesão', () => {
    const first = seedService(seedClient('A'), { avMode: 'annual', avAnnual: 5000, activation: '2026-06-15' });
    const second = seedService(seedClient('B'), { avMode: 'annual', avAnnual: 5000, activation: '2026-06-15' });

    runAudiovisualAnnualIfDue(new Date(2026, 5, 20), second);

    expect(paymentsFor(first)).toEqual([]);
    expect(paymentsFor(second)).toEqual([{ ref: 'AV-2026-06', amount: 5000 }]);
  });
});
