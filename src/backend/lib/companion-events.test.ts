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
  for (const table of ['work_order_attachments', 'companion_events', 'service_events', 'work_orders', 'support_ticket_entries', 'support_tickets', 'client_credits', 'treasury_movements', 'payment_receipts', 'payment_lines', 'payments', 'services', 'clients', 'app_settings']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // Os bancos são dos testes; a caixa predefinida vem das migrações e fica.
  db.prepare(`DELETE FROM treasury_accounts WHERE kind = 'banco'`).run();
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

function ticket(c: { clientId: number; serviceId: number }, status = 'aberto') {
  return db.prepare(`
    INSERT INTO support_tickets (client_id, service_id, subject, channel, category, priority, status)
    VALUES (?, ?, 'Sem net desde ontem', 'telefone', 'sem_ligacao', 'media', ?)
  `).run(c.clientId, c.serviceId, status).lastInsertRowid as number;
}

const resolved = (id: string, ticketId: number, notes: unknown = 'Reiniciei o CPE'): CompanionEvent => ({
  id, kind: 'ticket_done', at: '2026-11-05T15:00:00.000Z', payload: { ticketId, notes }
});

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

  test('an obsolete SMS event is rejected and acknowledged', async () => {
    const d = deps([
      { id: 'evt-00000005', kind: 'sms_in', at: '2026-11-05T10:00:00.000Z', payload: { from: '+2389912233', body: 'Ja paguei ontem' } }
    ]);
    await mod.pullCompanionEventsIfDue(d);
    expect(db.prepare('SELECT status, reason FROM companion_events WHERE id = ?').get('evt-00000005'))
      .toEqual({ status: 'rejected', reason: 'tipo desconhecido: sms_in' });
    expect(d.ack).toHaveBeenCalledWith(['evt-00000005']);
  });

  test('nothing happens while the phone is not paired', async () => {
    db.prepare(`UPDATE app_settings SET value = 'false' WHERE key = 'smsCompanionEnabled'`).run();
    const d = deps([]);
    expect(await mod.pullCompanionEventsIfDue(d)).toEqual({ skipped: true });
    expect(d.fetchEvents).not.toHaveBeenCalled();
  });
});

describe('o pedido de assistência resolvido no terreno', () => {
  test('fica resolvido, com a nota do terreno e a mudança de estado no histórico', async () => {
    const rui = client('Rui', '9955667');
    const id = ticket(rui);
    const d = deps([resolved('evt-00000010', id)]);

    expect(await mod.pullCompanionEventsIfDue(d)).toEqual({ pulled: 1, acked: true });

    const row = db.prepare('SELECT status, resolved_at AS resolvedAt FROM support_tickets WHERE id = ?').get(id) as { status: string; resolvedAt: string | null };
    expect(row.status).toBe('resolvido');
    expect(row.resolvedAt).not.toBeNull();
    const entries = db.prepare('SELECT kind, body FROM support_ticket_entries WHERE ticket_id = ? ORDER BY id').all(id);
    expect(entries).toEqual([
      { kind: 'mudanca_estado', body: 'Aberto → Resolvido' },
      { kind: 'nota', body: 'Resolvido no terreno (app móvel) — Reiniciei o CPE' }
    ]);
    expect(d.ack).toHaveBeenCalledWith(['evt-00000010']);
  });

  test('um pedido que não existe é recusado, e o telemóvel fica livre dele', async () => {
    const d = deps([resolved('evt-00000011', 4242)]);
    await mod.pullCompanionEventsIfDue(d);
    expect(db.prepare('SELECT status, reason FROM companion_events WHERE id = ?').get('evt-00000011'))
      .toEqual({ status: 'rejected', reason: 'Pedido não encontrado' });
    expect(d.ack).toHaveBeenCalled();
  });

  test('um pedido já fechado no PC não volta atrás com um evento antigo do telemóvel', async () => {
    // O telemóvel pode guardar o evento dias, fora da rede; entretanto o pedido
    // foi tratado no PC. Recusa-se, e o telemóvel fica livre dele.
    const id = ticket(client('Rui', null), 'fechado');
    const d = deps([resolved('evt-00000013', id)]);
    await mod.pullCompanionEventsIfDue(d);
    expect(db.prepare('SELECT status, reason FROM companion_events WHERE id = ?').get('evt-00000013'))
      .toEqual({ status: 'rejected', reason: 'Pedido já não estava aberto' });
    expect(db.prepare('SELECT status FROM support_tickets WHERE id = ?').get(id)).toEqual({ status: 'fechado' });
    expect(d.ack).toHaveBeenCalled();
  });

  test('sem dizer o que se fez não se resolve nada', async () => {
    const id = ticket(client('Marta', null));
    await mod.pullCompanionEventsIfDue(deps([resolved('evt-00000012', id, '   ')]));
    expect(db.prepare('SELECT status, reason FROM companion_events WHERE id = ?').get('evt-00000012'))
      .toEqual({ status: 'rejected', reason: 'dados do pedido invalidos' });
    expect(db.prepare('SELECT status FROM support_tickets WHERE id = ?').get(id)).toEqual({ status: 'aberto' });
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

  const bank = (name = 'BCA') =>
    db.prepare(`
      INSERT INTO treasury_accounts (kind, name, opening_date, active) VALUES ('banco', ?, '2026-01-01', 1)
    `).run(name).lastInsertRowid as number;

  const transfer = (id: string, clientCode: string, accountId?: number): CompanionEvent => ({
    id, kind: 'receipt_proposal', at: '2026-11-05T09:15:00.000Z',
    payload: { clientCode, amountCve: 2500, method: 'transferencia', ...(accountId ? { accountId } : {}) }
  });

  test('a conta indicada no terreno chega ao PC e vale quando ninguém escolhe outra', async () => {
    const ana = client('Ana', null);
    const payment = invoice(ana, 2500, '2026-10-10');
    const bca = bank();
    await mod.pullCompanionEventsIfDue(deps([transfer('evt-00000015', ana.code, bca)]));

    expect(mod.listReceiptProposals(db)[0]).toMatchObject({ method: 'transferencia', accountId: bca });
    expect(mod.confirmReceiptProposal(db, 'evt-00000015', { id: null, username: 'admin' })).toEqual({ ok: true });
    expect(db.prepare('SELECT payment_id AS p, account_id AS a FROM payment_receipts').get()).toEqual({ p: payment, a: bca });
  });

  test('o operador manda: a conta que ele escolhe ganha à do terreno', async () => {
    const ana = client('Ana', null);
    invoice(ana, 2500, '2026-10-10');
    const terreno = bank('BCA');
    const escolhido = bank('Caixa Económica');
    await mod.pullCompanionEventsIfDue(deps([transfer('evt-00000016', ana.code, terreno)]));

    expect(mod.confirmReceiptProposal(db, 'evt-00000016', { id: null, username: 'admin' }, escolhido)).toEqual({ ok: true });
    expect(db.prepare('SELECT account_id AS a FROM payment_receipts').get()).toEqual({ a: escolhido });
  });

  test('uma transferência sem banco não se confirma — diz-se porquê em vez de rebentar', async () => {
    const ana = client('Ana', null);
    invoice(ana, 2500, '2026-10-10');
    await mod.pullCompanionEventsIfDue(deps([transfer('evt-00000017', ana.code)]));

    const result = mod.confirmReceiptProposal(db, 'evt-00000017', { id: null, username: 'admin' });
    expect(result).toMatchObject({ ok: false, status: 400 });
    // Fica pendente, para ser confirmada com o banco escolhido no ecrã.
    expect(mod.listReceiptProposals(db)).toHaveLength(1);
  });
});

describe('o sino do telemóvel volta pelos eventos', () => {
  let admin: number;

  beforeEach(() => {
    for (const table of ['notification_reads', 'notification_seen', 'notifications', 'users']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    admin = Number(db.prepare("INSERT INTO users (username, password_hash, role, full_name, active) VALUES ('ana', 'x', 'admin', 'Ana', 1)").run().lastInsertRowid);
  });

  const phoneEvent = (id: string, kind: string, payload: Record<string, unknown>): CompanionEvent => ({
    id, kind, at: '2026-11-19T09:00:00.000Z', payload
  });

  const newNotice = (id: string, uid: string) => phoneEvent(id, 'notification_new', {
    uid, kind: 'sms_failed', severity: 'warn', title: 'SMS para Ana falhou', detail: 'sem rede', tab: 'historico'
  });

  test('o que nasce no telemóvel entra no histórico do PC, uma só vez', async () => {
    await mod.pullCompanionEventsIfDue(deps([newNotice('evt-00000101', 'phone:abc')]));
    await mod.pullCompanionEventsIfDue(deps([newNotice('evt-00000102', 'phone:abc')]));

    const rows = db.prepare("SELECT uid, origin, severity, section, focus FROM notifications").all();
    expect(rows).toEqual([{ uid: 'phone:abc', origin: 'phone', severity: 'warn', section: 'settings', focus: 'sms' }]);
    expect(db.prepare('SELECT status FROM companion_events WHERE id = ?').get('evt-00000102')).toEqual({ status: 'applied' });
  });

  test('o que se lê no telemóvel fica lido para quem confirmou o pareamento', async () => {
    await mod.pullCompanionEventsIfDue(deps([newNotice('evt-00000103', 'phone:abc')]));
    await mod.pullCompanionEventsIfDue(deps([phoneEvent('evt-00000104', 'notification_read', { uids: ['phone:abc', 'phone:nao-existe'] })]));

    const read = db.prepare('SELECT user_id AS userId FROM notification_reads').all();
    expect(read).toEqual([{ userId: admin }]);
    // Um uid desconhecido não rebenta o evento.
    expect(db.prepare('SELECT status FROM companion_events WHERE id = ?').get('evt-00000104')).toEqual({ status: 'applied' });
  });

  test('"visto até" nunca recua com o que vem do telemóvel', async () => {
    await mod.pullCompanionEventsIfDue(deps([
      { id: 'evt-00000105', kind: 'notification_seen', at: '2026-11-19T10:00:00.000Z', payload: {} }
    ]));
    await mod.pullCompanionEventsIfDue(deps([
      { id: 'evt-00000106', kind: 'notification_seen', at: '2026-11-19T08:00:00.000Z', payload: {} }
    ]));

    expect(db.prepare('SELECT seen_at AS seenAt FROM notification_seen WHERE user_id = ?').get(admin))
      .toEqual({ seenAt: '2026-11-19 10:00:00' });
  });

  test('uma notificação sem título é recusada', async () => {
    await mod.pullCompanionEventsIfDue(deps([phoneEvent('evt-00000107', 'notification_new', { uid: 'phone:x', severity: 'warn' })]));
    expect(db.prepare('SELECT status FROM companion_events WHERE id = ?').get('evt-00000107')).toEqual({ status: 'rejected' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });
});
