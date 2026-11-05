import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CompanionEvent, CompanionEventsDeps } from './companion-events';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let mod: typeof import('./companion-events');
let writeSecret: typeof import('./secrets').writeSecret;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-companion-events-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  mod = await import('./companion-events');
  ({ writeSecret } = await import('./secrets'));
});

beforeEach(() => {
  for (const table of ['sms_inbox', 'work_order_attachments', 'companion_events', 'service_events', 'work_orders', 'client_credits', 'treasury_movements', 'payment_receipts', 'payment_lines', 'payments', 'services', 'clients', 'app_settings']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('smsCompanionEnabled', 'true'), ('smsCompanionBaseUrl', 'http://192.168.1.50:8765')`).run();
  writeSecret(db, 'smsCompanionPairingKey', 'secret');
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function deps(events: CompanionEvent[], over: Partial<CompanionEventsDeps> = {}) {
  return {
    fetchEvents: vi.fn(async () => events),
    fetchMedia: vi.fn(async () => JPEG),
    ack: vi.fn(async () => true),
    ...over
  };
}

let seq = 0;
function client(name: string, phone: string | null) {
  seq += 1;
  const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES (?, ?, ?, 'active')`)
    .run(`CL-${seq}`, name, phone).lastInsertRowid as number;
  const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 2500, 10, 'active')`)
    .run(clientId).lastInsertRowid as number;
  return { clientId, serviceId, code: `CL-${seq}` };
}

function order(serviceId: number | null, status = 'agendada') {
  return db.prepare(`INSERT INTO work_orders (service_id, title, status, priority, event_type) VALUES (?, 'Trocar antena', ?, 'media', 'manutencao')`)
    .run(serviceId, status).lastInsertRowid as number;
}

function invoice(c: { clientId: number; serviceId: number }, amount: number, due: string) {
  seq += 1;
  return db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_date)
    VALUES (?, ?, ?, ?, ?, 'pending', '2026-09-01')
  `).run(c.clientId, c.serviceId, `2026-${String(seq).padStart(2, '0')}`, amount, due).lastInsertRowid as number;
}

const done = (id: string, workOrderId: number, extra: Record<string, unknown> = {}): CompanionEvent => ({
  id, kind: 'work_order_done', at: '2026-11-05T14:30:00.000Z', payload: { workOrderId, notes: 'Antena trocada', ...extra }
});

describe('pullCompanionEventsIfDue', () => {
  test('a field completion closes the order at field time, keeps photos and location, then acks', async () => {
    const ana = client('Ana', '9912233');
    const id = order(ana.serviceId);
    const d = deps([done('evt-00000001', id, { photos: ['photo-0001', 'photo-0002'], lat: 16.89, lon: -24.98 })]);

    expect(await mod.pullCompanionEventsIfDue(d)).toEqual({ pulled: 1, acked: true });

    expect(db.prepare('SELECT status, completed_at AS c, completion_notes AS n FROM work_orders WHERE id = ?').get(id))
      .toEqual({ status: 'concluida', c: '2026-11-05T14:30:00.000Z', n: 'Antena trocada' });
    const att = db.prepare('SELECT kind, data, lat FROM work_order_attachments WHERE work_order_id = ? ORDER BY id').all(id) as Array<{ kind: string; data: Buffer | null; lat: number | null }>;
    expect(att.map((a) => a.kind)).toEqual(['photo', 'photo', 'location']);
    expect(Buffer.compare(att[0].data!, JPEG)).toBe(0);
    expect(att[2].lat).toBe(16.89);
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_events').get()).toEqual({ n: 1 });
    expect(d.ack).toHaveBeenCalledWith(['evt-00000001']);
  });

  test('the same event pulled twice is applied once and acked again', async () => {
    const id = order(client('Ana', null).serviceId);
    const event = done('evt-00000002', id);
    await mod.pullCompanionEventsIfDue(deps([event]));
    const again = deps([event]);
    await mod.pullCompanionEventsIfDue(again);
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_events').get()).toEqual({ n: 1 });
    expect(again.ack).toHaveBeenCalledWith(['evt-00000002']);
  });

  test('a photo that does not arrive leaves the event on the phone for the next tick', async () => {
    const id = order(null);
    const d = deps([done('evt-00000003', id, { photos: ['photo-0003'] })], { fetchMedia: vi.fn(async () => null) });
    expect(await mod.pullCompanionEventsIfDue(d)).toEqual({ pulled: 0, acked: false });
    expect(d.ack).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM work_orders WHERE id = ?').get(id)).toEqual({ status: 'agendada' });
  });

  test('an order already closed on the desktop is not closed twice: recorded as rejected, still acked', async () => {
    const id = order(null, 'concluida');
    const d = deps([done('evt-00000004', id)]);
    await mod.pullCompanionEventsIfDue(d);
    expect(db.prepare('SELECT status, reason FROM companion_events WHERE id = ?').get('evt-00000004'))
      .toEqual({ status: 'rejected', reason: 'OS já estava concluída' });
    expect(d.ack).toHaveBeenCalled();
  });

  test('an SMS reply lands in the inbox, linked to the client by the last 7 digits', async () => {
    const ana = client('Ana', '991 22 33');
    await mod.pullCompanionEventsIfDue(deps([
      { id: 'evt-00000005', kind: 'sms_in', at: '2026-11-05T10:00:00.000Z', payload: { from: '+2389912233', body: 'Ja paguei ontem' } }
    ]));
    expect(db.prepare('SELECT client_id AS c, phone, body FROM sms_inbox').get()).toEqual({ c: ana.clientId, phone: '+2389912233', body: 'Ja paguei ontem' });
  });

  test('nothing happens while the phone is not paired', async () => {
    db.prepare(`UPDATE app_settings SET value = 'false' WHERE key = 'smsCompanionEnabled'`).run();
    const d = deps([]);
    expect(await mod.pullCompanionEventsIfDue(d)).toEqual({ skipped: true });
    expect(d.fetchEvents).not.toHaveBeenCalled();
  });
});

describe('receipt proposals', () => {
  const proposal = (id: string, clientCode: string, amountCve: number): CompanionEvent => ({
    id, kind: 'receipt_proposal', at: '2026-11-05T09:15:00.000Z', payload: { clientCode, amountCve, method: 'numerario', note: 'Pagou à porta' }
  });

  test('wait for the operator: nothing enters the cash on arrival', async () => {
    const ana = client('Ana', null);
    invoice(ana, 2500, '2026-10-10');
    await mod.pullCompanionEventsIfDue(deps([proposal('evt-00000010', ana.code, 2500)]));
    expect(db.prepare('SELECT COUNT(*) AS n FROM payment_receipts').get()).toEqual({ n: 0 });
    const [p] = mod.listReceiptProposals(db);
    expect(p).toMatchObject({ clientName: 'Ana', amountCve: 2500, method: 'numerario', target: { balanceCve: 2500 } });
  });

  test('confirm pays the oldest open invoice on the field date; the excess becomes credit', async () => {
    const ana = client('Ana', null);
    const older = invoice(ana, 2500, '2026-10-10');
    invoice(ana, 2500, '2026-11-10');
    await mod.pullCompanionEventsIfDue(deps([proposal('evt-00000011', ana.code, 3000)]));

    expect(mod.confirmReceiptProposal(db, 'evt-00000011', { id: null, username: 'admin' })).toEqual({ ok: true });
    expect(db.prepare('SELECT payment_id AS p, amount_cve AS a, payment_date AS d FROM payment_receipts').all())
      .toEqual([{ p: older, a: 2500, d: '2026-11-05' }]);
    expect(db.prepare('SELECT status, decided_by AS by FROM companion_events WHERE id = ?').get('evt-00000011')).toEqual({ status: 'applied', by: 'admin' });
    expect(mod.listReceiptProposals(db)).toEqual([]);
    // Decidida uma vez: confirmar de novo não paga outra vez.
    expect(mod.confirmReceiptProposal(db, 'evt-00000011', { id: null, username: 'admin' })).toMatchObject({ ok: false, status: 404 });
  });

  test('reject leaves the cash untouched', async () => {
    const ana = client('Ana', null);
    invoice(ana, 2500, '2026-10-10');
    await mod.pullCompanionEventsIfDue(deps([proposal('evt-00000012', ana.code, 2500)]));
    expect(mod.rejectReceiptProposal(db, 'evt-00000012', { username: 'admin' }, 'Não recebido')).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payment_receipts').get()).toEqual({ n: 0 });
    expect(mod.listReceiptProposals(db)).toEqual([]);
  });

  test('a client with nothing open cannot be confirmed', async () => {
    const ana = client('Ana', null);
    await mod.pullCompanionEventsIfDue(deps([proposal('evt-00000013', ana.code, 2500)]));
    expect(mod.confirmReceiptProposal(db, 'evt-00000013', { id: null, username: 'admin' })).toMatchObject({ ok: false, status: 409 });
  });

  test('an unknown client code is rejected on arrival', async () => {
    await mod.pullCompanionEventsIfDue(deps([proposal('evt-00000014', 'CL-NAO-EXISTE', 2500)]));
    expect(db.prepare('SELECT status FROM companion_events WHERE id = ?').get('evt-00000014')).toEqual({ status: 'rejected' });
  });
});
