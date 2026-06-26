import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let runOverdueNoticesIfDue: typeof import('./notices').runOverdueNoticesIfDue;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-notices-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // run migrations
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  ({ runOverdueNoticesIfDue } = await import('./notices'));
});

beforeEach(() => {
  // Child-first: notices reference outbox; both reference payments.
  db.prepare('DELETE FROM whatsapp_notices').run();
  db.prepare('DELETE FROM whatsapp_outbox').run();
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

function setSetting(key: string, value: string) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function enableNotices() {
  setSetting('autoNoticesEnabled', 'true');
  setSetting('ultraMsgInstanceId', 'instance123');
  setSetting('ultraMsgToken', 'token123');
  setSetting('whatsappSuspensionNoticeDays', '15');
  setSetting('noticeCooldownDays', '7');
}

function insertOverdue(params: { code: string; name: string; phone: string | null; daysOverdue: number; optOut?: boolean }) {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, phone, status, whatsapp_opt_out)
    VALUES (?, ?, ?, 'active', ?)
  `).run(params.code, params.name, params.phone, params.optOut ? 1 : 0).lastInsertRowid as number;

  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_centavos, due_day, status)
    VALUES (?, 250000, 10, 'active')
  `).run(clientId).lastInsertRowid as number;

  db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_centavos, due_date, status, invoice_number)
    VALUES (?, ?, strftime('%Y-%m', 'now'), 250000, date('now', ?), 'overdue', ?)
  `).run(clientId, serviceId, `-${params.daysOverdue} days`, `FT-${params.code}`);
}

const outboxCount = () => (db.prepare('SELECT COUNT(*) AS n FROM whatsapp_outbox').get() as { n: number }).n;
const noticesCount = () => (db.prepare('SELECT COUNT(*) AS n FROM whatsapp_notices').get() as { n: number }).n;

describe('runOverdueNoticesIfDue', () => {
  test('skips entirely when the toggle is disabled', async () => {
    insertOverdue({ code: 'A', name: 'Ana', phone: '9911111', daysOverdue: 20 });

    const result = await runOverdueNoticesIfDue(new Date());

    expect(result).toMatchObject({ skipped: true });
    expect(outboxCount()).toBe(0);
    expect(noticesCount()).toBe(0);
  });

  test('enqueues an outbox row per eligible candidate, logs the notice with outbox_id, skips opt-out and missing phone', async () => {
    enableNotices();
    insertOverdue({ code: 'OLD', name: 'Cliente Antigo', phone: '9910000', daysOverdue: 20 }); // suspension
    insertOverdue({ code: 'NEW', name: 'Cliente Recente', phone: '9920000', daysOverdue: 5 }); // overdue
    insertOverdue({ code: 'OPT', name: 'Opt Out', phone: '9930000', daysOverdue: 22, optOut: true }); // skip
    insertOverdue({ code: 'NOPH', name: 'Sem Telefone', phone: null, daysOverdue: 23 }); // skip

    const result = await runOverdueNoticesIfDue(new Date());

    expect(result).toMatchObject({ ran: true, enqueued: 2, skipped: 2 });

    const outbox = db.prepare('SELECT origin, kind FROM whatsapp_outbox').all() as Array<{ origin: string; kind: string }>;
    expect(outbox).toHaveLength(2);
    expect(outbox.every((r) => r.origin === 'auto' && r.kind === 'text')).toBe(true);

    const notices = db.prepare('SELECT notice_type AS type, status, origin, outbox_id AS outboxId FROM whatsapp_notices ORDER BY id').all() as Array<{ type: string; status: string; origin: string; outboxId: number | null }>;
    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.type).sort()).toEqual(['overdue', 'suspension']);
    expect(notices.every((n) => n.status === 'sent' && n.origin === 'auto' && n.outboxId !== null)).toBe(true);
  });

  test('daily guard prevents a second run on the same calendar day', async () => {
    enableNotices();
    insertOverdue({ code: 'A', name: 'Ana', phone: '9911111', daysOverdue: 20 });

    await runOverdueNoticesIfDue(new Date());
    const second = await runOverdueNoticesIfDue(new Date());

    expect(second).toMatchObject({ skipped: true });
  });

  test('cooldown dedupe avoids enqueuing the same notice type again on a later day', async () => {
    enableNotices();
    insertOverdue({ code: 'A', name: 'Ana', phone: '9911111', daysOverdue: 20 });

    await runOverdueNoticesIfDue(new Date()); // day 1: enqueues 1
    const tomorrow = new Date(Date.now() + 86_400_000);
    const result = await runOverdueNoticesIfDue(tomorrow); // day 2: deduped by cooldown

    expect(result).toMatchObject({ ran: true, enqueued: 0, skipped: 1 });
    expect(outboxCount()).toBe(1);
    expect(noticesCount()).toBe(1);
  });
});
