import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { writeSecret } from './secrets';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let mod: typeof import('./sms-notices');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-sms-notices-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  mod = await import('./sms-notices');
});

beforeEach(() => {
  db.prepare('DELETE FROM whatsapp_notices').run();
  db.prepare('DELETE FROM whatsapp_outbox').run();
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
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

/** 10:00 de Cabo Verde do dia UTC de hoje: os avisos só saem a partir das 08:00. */
function daytime(): Date {
  const at = new Date();
  at.setUTCHours(11, 0, 0, 0);
  return at;
}

function setSetting(key: string, value: string) {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** SMS ligado e pareado; o WhatsApp fica de propósito por configurar. */
function enableSms() {
  setSetting('smsAutoNoticesEnabled', 'true');
  setSetting('smsCompanionEnabled', 'true');
  setSetting('smsCompanionBaseUrl', 'http://192.168.1.50:8765');
  writeSecret(db, 'smsCompanionPairingKey', 'secret');
  setSetting('autoSuspensionGraceDays', '21'); // aviso de suspensão aos 15 dias (corte aos 22)
  setSetting('noticeCooldownDays', '7');
}

// daysFromDue: negativo = vence no futuro, positivo = dias em atraso.
function insertInvoice(p: { code: string; phone: string | null; daysFromDue: number; optOut?: boolean; status?: 'pending' | 'overdue' }) {
  const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status, whatsapp_opt_out) VALUES (?, ?, ?, 'active', ?)`)
    .run(p.code, `Cliente ${p.code}`, p.phone, p.optOut ? 1 : 0).lastInsertRowid as number;
  const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 2500, 10, 'active')`)
    .run(clientId).lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number)
    VALUES (?, ?, strftime('%Y-%m', 'now'), 2500, date('now', ?), ?, ?)
  `).run(clientId, serviceId, `${-p.daysFromDue} days`, p.status ?? (p.daysFromDue > 0 ? 'overdue' : 'pending'), `FT-${p.code}`).lastInsertRowid as number;
}

const outbox = () => db.prepare('SELECT payment_id AS paymentId, event_type AS eventType, to_phone AS toPhone, body, status FROM sms_outbox ORDER BY id').all() as
  Array<{ paymentId: number; eventType: string; toPhone: string; body: string; status: string }>;

describe('smsEventForStage', () => {
  test('maps the funnel to SMS templates and leaves the pre-due reminder out', () => {
    expect(mod.smsEventForStage('reminder')).toBeNull();
    expect(mod.smsEventForStage('overdue')).toBe('payment_overdue');
    expect(mod.smsEventForStage('warning')).toBe('payment_overdue');
    expect(mod.smsEventForStage('suspension')).toBe('suspension_notice');
  });
});

describe('runSmsOverdueNoticesIfDue', () => {
  test('skips when the toggle is off', () => {
    setSetting('smsCompanionEnabled', 'true');
    insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    expect(mod.runSmsOverdueNoticesIfDue(daytime())).toMatchObject({ skipped: true });
    expect(outbox()).toHaveLength(0);
  });

  test('skips when the phone is not paired', () => {
    setSetting('smsAutoNoticesEnabled', 'true');
    setSetting('smsCompanionEnabled', 'true');
    insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    expect(mod.runSmsOverdueNoticesIfDue(daytime())).toEqual({ skipped: true, reason: 'telemovel SMS nao pareado' });
  });

  test('queues one SMS per eligible invoice, without WhatsApp configured', () => {
    enableSms();
    const susp = insertInvoice({ code: 'SUSP', phone: '9910000', daysFromDue: 20 });
    const late = insertInvoice({ code: 'LATE', phone: '238 992 0000', daysFromDue: 3 });
    insertInvoice({ code: 'SOON', phone: '9930000', daysFromDue: -2 }); // lembrete: sem SMS
    insertInvoice({ code: 'OPT', phone: '9940000', daysFromDue: 20, optOut: true });
    insertInvoice({ code: 'NOPH', phone: null, daysFromDue: 20 });
    insertInvoice({ code: 'BAD', phone: '12', daysFromDue: 20 });

    const result = mod.runSmsOverdueNoticesIfDue(daytime());
    expect(result).toMatchObject({ ran: true, enqueued: 2, skipped: 4 });

    const rows = outbox();
    expect(rows.map((r) => [r.paymentId, r.eventType])).toEqual([[susp, 'suspension_notice'], [late, 'payment_overdue']]);
    expect(rows.every((r) => r.status === 'pending_dispatch')).toBe(true);
    expect(rows[1].toPhone).toBe('+2389920000');
    expect(rows[1].body).toContain('FT-LATE');
    // A mesma data que o insertInvoice gravou (há 3 dias), no formato da mensagem.
    const { lateDue } = db.prepare(`SELECT strftime('%d-%m-%Y', 'now', '-3 days') AS lateDue`).get() as { lateDue: string };
    expect(rows[1].body).toContain(`venceu a ${lateDue}`);
  });

  test('runs once per day', () => {
    enableSms();
    insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    expect(mod.runSmsOverdueNoticesIfDue(daytime())).toMatchObject({ ran: true, enqueued: 1 });
    expect(mod.smsOverdueNoticesDueToday(daytime())).toBe(false);
    expect(mod.runSmsOverdueNoticesIfDue(daytime())).toMatchObject({ skipped: true });
    expect(outbox()).toHaveLength(1);
  });

  test('cooldown skips an invoice already messaged, but not after a rejection', () => {
    enableSms();
    const paymentId = insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    db.prepare(`INSERT INTO sms_outbox (payment_id, event_type, to_phone, body, status) VALUES (?, 'suspension_notice', '+2389911111', 'manual', 'sent')`).run(paymentId);
    expect(mod.runSmsOverdueNoticesIfDue(daytime())).toMatchObject({ ran: true, enqueued: 0, skipped: 1 });

    db.prepare(`UPDATE sms_outbox SET status='rejected'`).run();
    setSetting('lastSmsOverdueNoticesDate', '');
    expect(mod.runSmsOverdueNoticesIfDue(daytime())).toMatchObject({ ran: true, enqueued: 1 });
  });
});

/** Um aviso automático de WhatsApp para a fatura, com a mensagem na fila no estado dado. */
function whatsappNotice(paymentId: number, stage: string, outboxStatus: string): number {
  const { clientId } = db.prepare('SELECT client_id AS clientId FROM payments WHERE id = ?').get(paymentId) as { clientId: number };
  const outboxId = Number(db.prepare(`
    INSERT INTO whatsapp_outbox (to_phone, kind, body, client_id, origin, status) VALUES ('+2389911111', 'text', 'x', ?, 'auto', ?)
  `).run(clientId, outboxStatus).lastInsertRowid);
  db.prepare(`
    INSERT INTO whatsapp_notices (payment_id, client_id, notice_type, origin, phone, body, status, outbox_id)
    VALUES (?, ?, ?, 'auto', '+2389911111', 'x', 'sent', ?)
  `).run(paymentId, clientId, stage, outboxId);
  return outboxId;
}

function enableWhatsapp() {
  setSetting('ultraMsgInstanceId', 'instance1');
  writeSecret(db, 'ultraMsgToken', 'token');
}

describe('SMS como recurso do WhatsApp', () => {
  test('nada sai antes das 08:00 de Cabo Verde', () => {
    enableSms();
    insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    const dawn = daytime();
    dawn.setUTCHours(7); // 06:00 em Cabo Verde
    expect(mod.smsOverdueNoticesDueToday(dawn)).toBe(false);
    expect(mod.runSmsOverdueNoticesIfDue(dawn)).toMatchObject({ skipped: true });
    expect(outbox()).toHaveLength(0);
  });

  test('o aviso de suspensão traz o dia real do corte (vencimento + tolerância + 1)', () => {
    enableSms();
    insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    mod.runSmsOverdueNoticesIfDue(daytime());
    const { cut } = db.prepare(`SELECT strftime('%d-%m-%Y', 'now', '-20 days', '+22 days') AS cut`).get() as { cut: string };
    expect(outbox()[0]).toMatchObject({ eventType: 'suspension_notice' });
    expect(outbox()[0].body).toContain(`suspensa a ${cut}`);
  });

  test('não duplica o que o WhatsApp já levou, mas cobre o que falhou', () => {
    enableSms();
    enableWhatsapp();
    const delivered = insertInvoice({ code: 'OK', phone: '9911111', daysFromDue: 20 });
    const failed = insertInvoice({ code: 'KO', phone: '9922222', daysFromDue: 20 });
    whatsappNotice(delivered, 'suspension', 'delivered');
    whatsappNotice(failed, 'suspension', 'failed');

    expect(mod.runSmsOverdueNoticesIfDue(daytime())).toMatchObject({ ran: true, enqueued: 1, skipped: 1 });
    expect(outbox().map((row) => row.paymentId)).toEqual([failed]);
  });

  test('uma mensagem de WhatsApp que falha de vez passa logo a SMS, uma só vez', () => {
    enableSms();
    const paymentId = insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    const outboxId = whatsappNotice(paymentId, 'suspension', 'failed');

    expect(mod.enqueueSmsFallbackForWhatsapp(outboxId)).toBe(true);
    expect(mod.enqueueSmsFallbackForWhatsapp(outboxId)).toBe(false);
    expect(outbox()).toEqual([expect.objectContaining({ paymentId, eventType: 'suspension_notice' })]);
  });

  test('sem o telemóvel pareado o recurso não faz nada', () => {
    const paymentId = insertInvoice({ code: 'A', phone: '9911111', daysFromDue: 20 });
    expect(mod.enqueueSmsFallbackForWhatsapp(whatsappNotice(paymentId, 'suspension', 'failed'))).toBe(false);
    expect(outbox()).toHaveLength(0);
  });
});
