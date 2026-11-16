import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { writeSecret } from './secrets';
import { previewMaintenanceNotice, renderMaintenanceBodies, sendMaintenanceNotice } from './maintenance-notices';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let catalogId: number;
let enqueueSmsFallbackForWhatsapp: typeof import('./sms-notices').enqueueSmsFallbackForWhatsapp;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-maintenance-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  ({ enqueueSmsFallbackForWhatsapp } = await import('./sms-notices'));
  catalogId = Number(db.prepare("INSERT INTO equipment_catalog (type, model) VALUES ('antena', 'Teste')").run().lastInsertRowid);
});

beforeEach(() => {
  for (const table of ['maintenance_notice_recipients', 'maintenance_notices', 'whatsapp_outbox', 'sms_outbox', 'backbone_assignment_links',
    'service_device_assignments', 'backbone_links', 'backbone_devices', 'services', 'clients', 'app_settings']) db.prepare(`DELETE FROM ${table}`).run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

const set = (key: string, value: string) => db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
const device = (name: string) => Number(db.prepare("INSERT INTO backbone_devices (catalog_id, name, zone) VALUES (?, ?, 'Praia')").run(catalogId, name).lastInsertRowid);
function client(code: string, backboneId: number, extra: { phone?: string | null; optOut?: boolean } = {}) {
  const clientId = Number(db.prepare('INSERT INTO clients (client_code, full_name, phone, whatsapp_opt_out) VALUES (?, ?, ?, ?)')
    .run(code, `Cliente ${code}`, extra.phone === undefined ? `99122${code.replace(/\D/g, '').padStart(2, '0')}` : extra.phone, extra.optOut ? 1 : 0).lastInsertRowid);
  const serviceId = Number(db.prepare("INSERT INTO services (client_id, status) VALUES (?, 'active')").run(clientId).lastInsertRowid);
  const assignmentId = Number(db.prepare("INSERT INTO service_device_assignments (service_id, catalog_id, start_date) VALUES (?, ?, '2026-01-01')").run(serviceId, catalogId).lastInsertRowid);
  db.prepare('INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id) VALUES (?, ?)').run(backboneId, assignmentId);
}
const whatsapp = () => { set('ultraMsgInstanceId', 'instance123'); writeSecret(db, 'ultraMsgToken', 'token123'); };
const sms = () => { set('smsCompanionEnabled', 'true'); set('smsCompanionBaseUrl', 'http://10.0.0.9:8765'); writeSecret(db, 'smsCompanionPairingKey', 'k'); };
const window = { kind: 'calibracao' as const, day: '2026-11-20', start: '09:00', end: '11:30' };

/** Uma torre com um ramo atrás: a manutenção na torre chega a quem pende do ramo. */
function tower() {
  const torre = device('Torre A');
  const ramo = device('Ramo B');
  db.prepare('INSERT INTO backbone_links (device_id, upstream_device_id) VALUES (?, ?)').run(ramo, torre);
  client('C1', torre); client('C2', ramo); client('C3', ramo, { optOut: true }); client('C4', ramo, { phone: null });
  return torre;
}

test('a pré-visualização conta os clientes a jusante e o canal de cada um', () => {
  whatsapp();
  expect(previewMaintenanceNotice(db, tower())).toEqual({ total: 4, whatsapp: 2, sms: 0, skipped: 2 });
});

test('o envio grava o aviso e põe uma mensagem por cliente, com a janela no texto', () => {
  whatsapp();
  const result = sendMaintenanceNotice(db, tower(), window, null);
  expect(result).toMatchObject({ total: 4, whatsapp: 2, sms: 0, skipped: 2 });
  const bodies = db.prepare('SELECT body FROM whatsapp_outbox').all() as Array<{ body: string }>;
  expect(bodies).toHaveLength(2);
  expect(bodies[0].body).toContain('No dia 20 de novembro, entre as 09:00 e as 11:30, vamos fazer a calibração do equipamento');
  expect((db.prepare('SELECT COUNT(*) AS n FROM maintenance_notice_recipients').get() as { n: number }).n).toBe(2);
});

test('sem WhatsApp, ou com a Meta, segue por SMS sem acentos e em 160 caracteres', () => {
  sms();
  set('companyName', 'NovaTech Telecom');
  set('whatsappProvider', 'meta-cloud'); set('metaPhoneNumberId', '1055'); writeSecret(db, 'metaAccessToken', 'token');
  const result = sendMaintenanceNotice(db, tower(), { ...window, kind: 'configuracao' }, null);
  expect(result).toMatchObject({ whatsapp: 0, sms: 2 });
  const body = (db.prepare("SELECT body FROM sms_outbox WHERE event_type = 'maintenance_notice'").get() as { body: string }).body;
  expect(body).toContain('faremos uma mudanca de configuracao');
  expect(body.length).toBeLessThanOrEqual(160);
});

test('o SMS cabe num envio em qualquer tipo, mesmo no mês mais comprido', () => {
  set('companyName', 'NovaTech Telecom');
  for (const kind of ['manutencao', 'calibracao', 'configuracao'] as const) {
    expect(renderMaintenanceBodies(db, { ...window, kind, day: '2027-02-28' }).sms.length).toBeLessThanOrEqual(160);
  }
});

test('um WhatsApp de manutenção que falhou de vez passa a SMS com o texto do aviso', () => {
  whatsapp(); sms();
  sendMaintenanceNotice(db, tower(), window, null);
  const { id } = db.prepare('SELECT id FROM whatsapp_outbox LIMIT 1').get() as { id: number };
  expect(enqueueSmsFallbackForWhatsapp(id)).toBe(true);
  const row = db.prepare("SELECT body FROM sms_outbox WHERE event_type = 'maintenance_notice'").get() as { body: string };
  expect(row.body).toBe(renderMaintenanceBodies(db, window).sms);
});
