import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { writeSecret } from './secrets';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let runOutageNoticesIfDue: typeof import('./outage-notices').runOutageNoticesIfDue;
let enqueueSmsFallbackForWhatsapp: typeof import('./sms-notices').enqueueSmsFallbackForWhatsapp;
let runWhatsappOutboxIfDue: typeof import('./whatsapp-outbox').runWhatsappOutboxIfDue;
let runSmsOutboxIfDue: typeof import('./sms-outbox').runSmsOutboxIfDue;
let catalogId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-outage-notices-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  ({ runOutageNoticesIfDue } = await import('./outage-notices'));
  ({ enqueueSmsFallbackForWhatsapp } = await import('./sms-notices'));
  ({ runWhatsappOutboxIfDue } = await import('./whatsapp-outbox'));
  ({ runSmsOutboxIfDue } = await import('./sms-outbox'));
  catalogId = Number(db.prepare("INSERT INTO equipment_catalog (type, model) VALUES ('antena', 'Teste')").run().lastInsertRowid);
});

beforeEach(() => {
  for (const table of ['incident_notices', 'whatsapp_outbox', 'sms_outbox', 'network_probe_events', 'network_probe_state',
    'backbone_assignment_links', 'service_device_assignments', 'backbone_links', 'backbone_devices', 'services', 'clients', 'app_settings']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('networkProbeEnabled', 'true')").run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});
afterEach(() => vi.unstubAllGlobals());

/** 12:00 UTC = 11:00 em Cabo Verde. */
const NOW = new Date('2026-11-15T12:00:00Z');
const sql = (at: Date) => at.toISOString().slice(0, 19).replace('T', ' ');
const minutesAgo = (minutes: number) => sql(new Date(NOW.getTime() - minutes * 60_000));

const setSetting = (key: string, value: string) => db.prepare(`
  INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(key, value);

function enable() {
  setSetting('outageNoticesEnabled', 'true');
  setSetting('ultraMsgInstanceId', 'instance123');
  writeSecret(db, 'ultraMsgToken', 'token123');
}

function enableSms() {
  setSetting('smsCompanionEnabled', 'true');
  setSetting('smsCompanionBaseUrl', 'http://10.0.0.9:8080');
  writeSecret(db, 'smsCompanionPairingKey', 'k');
}

const device = (name: string) => Number(db.prepare("INSERT INTO backbone_devices (catalog_id, name, zone) VALUES (?, ?, 'Praia')")
  .run(catalogId, name).lastInsertRowid);
const event = (id: number, toState: 'up' | 'down', at: string) =>
  db.prepare(`INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, gap_before)
    VALUES ('backbone', ?, '10.0.0.1', ?, ?, ?, 0)`).run(id, toState === 'up' ? 'down' : 'up', toState, at);
const stillDown = (id: number) =>
  db.prepare(`INSERT INTO network_probe_state (target_kind, target_id, ip_address, state) VALUES ('backbone', ?, '10.0.0.1', 'down')`).run(id);
const backUp = (id: number) => db.prepare("UPDATE network_probe_state SET state = 'up' WHERE target_kind = 'backbone' AND target_id = ?").run(id);

function client(code: string, backboneId: number, extra: { phone?: string | null; optOut?: boolean } = {}) {
  const clientId = Number(db.prepare('INSERT INTO clients (client_code, full_name, phone, whatsapp_opt_out) VALUES (?, ?, ?, ?)')
    .run(code, `Cliente ${code}`, extra.phone === undefined ? `99111${code.replace(/\D/g, '').padStart(2, '0')}` : extra.phone, extra.optOut ? 1 : 0).lastInsertRowid);
  const serviceId = Number(db.prepare("INSERT INTO services (client_id, status) VALUES (?, 'active')").run(clientId).lastInsertRowid);
  const assignmentId = Number(db.prepare("INSERT INTO service_device_assignments (service_id, catalog_id, start_date) VALUES (?, ?, '2026-01-01')")
    .run(serviceId, catalogId).lastInsertRowid);
  db.prepare('INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id) VALUES (?, ?)').run(backboneId, assignmentId);
  return clientId;
}

/** Antena com três clientes, em baixo desde há `minutes` minutos. */
function openOutage(minutes: number) {
  const antena = device('Antena X');
  client('C1', antena); client('C2', antena); client('C3', antena);
  event(antena, 'down', minutesAgo(minutes));
  stillDown(antena);
  return antena;
}

const count = (where: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${where}`).get() as { n: number }).n;

describe('runOutageNoticesIfDue', () => {
  test('desligado por omissão: não avisa ninguém', async () => {
    openOutage(30);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ skipped: true });
    expect(count('whatsapp_outbox')).toBe(0);
  });

  test('não avisa usando o estado antigo quando a sonda está desligada', async () => {
    enable();
    openOutage(30);
    setSetting('networkProbeEnabled', 'false');
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ skipped: true });
    expect(count('whatsapp_outbox')).toBe(0);
  });

  test('não despacha aviso pendente quando a sonda foi desligada', async () => {
    enable();
    openOutage(30);
    await runOutageNoticesIfDue(NOW);
    setSetting('networkProbeEnabled', 'false');
    let sent = 0;
    const provider = { id: 'ultramsg' as const, label: 'Teste', sendText: async () => { sent++; return { ok: true as const }; }, sendDocument: async () => ({ ok: true as const }) };
    await runWhatsappOutboxIfDue(NOW, { resolveProvider: () => provider, renderPdf: async () => ({ buffer: Buffer.alloc(0), filename: 'x' }) });
    expect(sent).toBe(0);
  });

  test('avisa uma vez cada cliente a jusante, e só uma', async () => {
    enable();
    openOutage(11);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ ran: true, outage: 3, restored: 0 });
    expect(count("incident_notices WHERE kind = 'outage' AND channel = 'whatsapp'")).toBe(3);
    expect(count('whatsapp_outbox')).toBe(3);
    expect((db.prepare('SELECT body FROM whatsapp_outbox LIMIT 1').get() as { body: string }).body).toMatch(/avaria/);

    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 0 });
    expect(count('whatsapp_outbox')).toBe(3);
  });

  test('uma queda curta não chega a avisar', async () => {
    enable();
    openOutage(5);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 0 });
    setSetting('outageNoticeDelayMinutes', '3');
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 3 });
  });

  test('usa o texto de avaria configurado pelo operador', async () => {
    enable();
    setSetting('whatsappOutageTemplate', 'Aviso personalizado da {empresa}');
    setSetting('companyName', 'Rede X');
    openOutage(20);
    await runOutageNoticesIfDue(NOW);
    expect((db.prepare('SELECT body FROM whatsapp_outbox LIMIT 1').get() as { body: string }).body).toBe('Aviso personalizado da Rede X');
  });

  test('personaliza o texto com nome e código do cliente', async () => {
    enable();
    setSetting('whatsappOutageTemplate', 'Olá {nome}, código {codigo}.');
    const antena = device('Antena X');
    client('C1', antena);
    event(antena, 'down', minutesAgo(30));
    stillDown(antena);
    await runOutageNoticesIfDue(NOW);
    expect((db.prepare('SELECT body FROM whatsapp_outbox LIMIT 1').get() as { body: string }).body).toBe('Olá Cliente C1, código C1.');
  });

  test('o reposto só vai a quem soube da avaria', async () => {
    enable();
    const antena = openOutage(20);
    await runOutageNoticesIfDue(NOW);
    db.prepare("UPDATE whatsapp_outbox SET status = 'sent'").run();
    client('C4', antena); // ligado depois do aviso

    event(antena, 'up', minutesAgo(1));
    backUp(antena);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 0, restored: 3 });
    expect(count("incident_notices WHERE kind = 'restored'")).toBe(3);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ restored: 0 });
  });

  test('não envia reposto enquanto o aviso de avaria não foi enviado', async () => {
    enable();
    const antena = openOutage(20);
    await runOutageNoticesIfDue(NOW);
    event(antena, 'up', minutesAgo(1));
    backUp(antena);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ restored: 0 });
    expect(count("incident_notices WHERE kind = 'restored'")).toBe(0);
    expect(count("whatsapp_outbox WHERE status = 'pending'")).toBe(0);
  });

  test('um regresso não observado (buraco da sonda) não diz que foi reposto', async () => {
    enable();
    const antena = openOutage(20);
    await runOutageNoticesIfDue(NOW);
    backUp(antena); // deixou de estar em baixo sem regresso gravado → `unknown`
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ restored: 0 });
  });

  test('salta quem recusou avisos e quem não tem telefone', async () => {
    enable();
    const antena = device('Antena X');
    client('C1', antena);
    client('C2', antena, { optOut: true });
    client('C3', antena, { phone: null });
    event(antena, 'down', minutesAgo(30));
    stillDown(antena);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 1, skipped: 2 });
  });

  test('de noite espera; de manhã, se continuar em baixo, avisa', async () => {
    enable();
    const night = new Date('2026-11-16T00:30:00Z'); // 23:30 em CV
    const antena = device('Antena X');
    client('C1', antena);
    event(antena, 'down', sql(new Date(night.getTime() - 60 * 60_000)));
    stillDown(antena);
    expect(await runOutageNoticesIfDue(night)).toMatchObject({ skipped: true });
    expect(await runOutageNoticesIfDue(new Date('2026-11-16T09:05:00Z'))).toMatchObject({ outage: 1 });
  });

  test('cancela aviso pendente mesmo se a avaria terminar depois das 22 horas', async () => {
    enable();
    const antena = openOutage(30);
    await runOutageNoticesIfDue(NOW);
    const night = new Date('2026-11-15T23:30:00Z');
    event(antena, 'up', sql(new Date(night.getTime() - 60_000)));
    backUp(antena);
    await runOutageNoticesIfDue(night);
    expect(count("whatsapp_outbox WHERE status = 'pending'")).toBe(0);
  });

  test('cancela avisos antigos após mais de um dia sem executar o job', async () => {
    enable();
    const antena = openOutage(30);
    await runOutageNoticesIfDue(NOW);
    event(antena, 'up', minutesAgo(1));
    backUp(antena);
    await runOutageNoticesIfDue(new Date(NOW.getTime() + 26 * 3_600_000));
    expect(count("whatsapp_outbox WHERE status = 'pending'")).toBe(0);
  });

  test('não despacha avisos pendentes depois das 22 horas', async () => {
    enable();
    openOutage(30);
    await runOutageNoticesIfDue(NOW);
    let sent = 0;
    const provider = { id: 'ultramsg' as const, label: 'Teste', sendText: async () => { sent++; return { ok: true as const }; }, sendDocument: async () => ({ ok: true as const }) };
    await runWhatsappOutboxIfDue(new Date('2026-11-15T23:30:00Z'), { resolveProvider: () => provider, renderPdf: async () => ({ buffer: Buffer.alloc(0), filename: 'x' }) });
    expect(sent).toBe(0);
  });

  test('sem WhatsApp vai por SMS', async () => {
    setSetting('outageNoticesEnabled', 'true');
    setSetting('whatsappChannelEnabled', 'false');
    enableSms();
    openOutage(30);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 3 });
    expect(count("sms_outbox WHERE event_type = 'outage_notice'")).toBe(3);
    expect(count("incident_notices WHERE channel = 'sms'")).toBe(3);
  });

  test('cancela SMS ainda não despachado quando a avaria acaba', async () => {
    setSetting('outageNoticesEnabled', 'true');
    setSetting('whatsappChannelEnabled', 'false');
    enableSms();
    const antena = openOutage(30);
    await runOutageNoticesIfDue(NOW);
    event(antena, 'up', minutesAgo(1));
    backUp(antena);
    await runOutageNoticesIfDue(NOW);
    expect(count("sms_outbox WHERE status = 'pending_dispatch'")).toBe(0);
  });

  test('ao terminar, reconcilia SMS com resposta perdida sem o voltar a despachar', async () => {
    setSetting('outageNoticesEnabled', 'true');
    setSetting('whatsappChannelEnabled', 'false');
    enableSms();
    const antena = openOutage(30);
    await runOutageNoticesIfDue(NOW);
    db.prepare("UPDATE sms_outbox SET android_request_id = 'pedido-' || id").run();
    event(antena, 'up', minutesAgo(1));
    backUp(antena);
    await runOutageNoticesIfDue(NOW);
    expect(count("sms_outbox WHERE status = 'pending_dispatch'")).toBe(0);
    expect(count("sms_outbox WHERE status = 'pending_approval'")).toBe(3);
  });

  test('não despacha SMS de avaria depois das 22 horas', async () => {
    setSetting('outageNoticesEnabled', 'true');
    setSetting('whatsappChannelEnabled', 'false');
    enableSms();
    openOutage(30);
    await runOutageNoticesIfDue(NOW);
    let sent = 0;
    await runSmsOutboxIfDue(new Date('2026-11-15T23:30:00Z'), {
      postRequest: async ({ requestId }) => { sent++; return { ok: true, androidRequestId: requestId }; },
      fetchStatus: async () => ({ status: 'sent' })
    });
    expect(sent).toBe(0);
  });

  test('sem nenhum canal não corre', async () => {
    setSetting('outageNoticesEnabled', 'true');
    setSetting('whatsappChannelEnabled', 'false');
    openOutage(30);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ skipped: true });
  });

  test('Meta sem modelo escolhido cai para SMS; com modelo aprovado leva o modelo', async () => {
    setSetting('outageNoticesEnabled', 'true');
    setSetting('whatsappProvider', 'meta-cloud');
    setSetting('metaPhoneNumberId', '1055');
    setSetting('metaBusinessAccountId', '123');
    writeSecret(db, 'metaAccessToken', 'token');
    enableSms();
    openOutage(30);
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 3 });
    expect(count('whatsapp_outbox')).toBe(0);
    expect(count('sms_outbox')).toBe(3);

    db.prepare('DELETE FROM incident_notices').run();
    db.prepare('DELETE FROM sms_outbox').run();
    setSetting('metaTemplateOutage', 'avaria|pt_PT');
    const { fallbackWhatsappOutageTemplate } = await import('../../shared/whatsapp');
    const { numberMetaVariables } = await import('../../shared/whatsapp');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ data: [
      { name: 'avaria', language: 'pt_PT', status: 'APPROVED', components: [{ type: 'BODY', text: numberMetaVariables(fallbackWhatsappOutageTemplate) }] }
    ] }) })));
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 3 });
    const row = db.prepare('SELECT template_json FROM whatsapp_outbox LIMIT 1').get() as { template_json: string };
    expect(JSON.parse(row.template_json)).toMatchObject({ name: 'avaria', language: 'pt_PT' });
  });

  test('não avisa por uma avaria que termina durante a consulta à Meta', async () => {
    setSetting('outageNoticesEnabled', 'true');
    setSetting('whatsappProvider', 'meta-cloud');
    setSetting('metaPhoneNumberId', '1055');
    setSetting('metaBusinessAccountId', '123');
    setSetting('metaTemplateOutage', 'avaria|pt_PT');
    writeSecret(db, 'metaAccessToken', 'token');
    const antena = openOutage(30);
    const { fallbackWhatsappOutageTemplate, numberMetaVariables } = await import('../../shared/whatsapp');
    vi.stubGlobal('fetch', vi.fn(async () => {
      event(antena, 'up', minutesAgo(1));
      backUp(antena);
      return { ok: true, text: async () => JSON.stringify({ data: [{ name: 'avaria', language: 'pt_PT', status: 'APPROVED', components: [{ type: 'BODY', text: numberMetaVariables(fallbackWhatsappOutageTemplate) }] }] }) };
    }));
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 0 });
    expect(count('whatsapp_outbox')).toBe(0);
  });

  test('um corte da antena Starlink não gera aviso', async () => {
    enable();
    db.prepare("INSERT INTO starlink_dish_outages (dish_id, started_at, duration_ms, cause) VALUES ('d', ?, 30000, 'NO_SCHEDULE')")
      .run(minutesAgo(30));
    client('C1', device('Antena X'));
    expect(await runOutageNoticesIfDue(NOW)).toMatchObject({ outage: 0, restored: 0 });
    db.prepare('DELETE FROM starlink_dish_outages').run();
  });
});

describe('recurso SMS de um aviso de avaria', () => {
  test('um WhatsApp de avaria que falhou de vez passa a SMS', async () => {
    enable();
    enableSms();
    openOutage(30);
    await runOutageNoticesIfDue(NOW);
    const { id } = db.prepare('SELECT id FROM whatsapp_outbox LIMIT 1').get() as { id: number };
    expect(enqueueSmsFallbackForWhatsapp(id)).toBe(true);
    expect(count("sms_outbox WHERE event_type = 'outage_notice'")).toBe(1);
  });

  test('uma falha ao associar o SMS reverte a entrada na fila', async () => {
    enable();
    enableSms();
    openOutage(30);
    await runOutageNoticesIfDue(NOW);
    const { id } = db.prepare('SELECT id FROM whatsapp_outbox LIMIT 1').get() as { id: number };
    db.exec("CREATE TEMP TRIGGER reject_incident_update BEFORE UPDATE ON incident_notices BEGIN SELECT RAISE(ABORT, 'erro'); END");
    try {
      expect(enqueueSmsFallbackForWhatsapp(id)).toBe(false);
      expect(count("sms_outbox WHERE event_type = 'outage_notice'")).toBe(0);
    } finally {
      db.exec('DROP TRIGGER reject_incident_update');
    }
  });
});
