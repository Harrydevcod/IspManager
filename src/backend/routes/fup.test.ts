/**
 * Uso justo pela API, com autenticação a sério: o operador lê, só o
 * administrador grava; a pré-visualização nunca grava.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let admin: string;
let operator: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-fup-routes-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  delete process.env.ISPM_AUTH;

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  closeDatabaseForTests = database.closeDatabaseForTests;
  db = database.getSqliteDatabase();
  db.exec('DELETE FROM clients');
  db.prepare(`INSERT INTO internet_plans (id, name, monthly_price_cve, router_profile, download_mbps, upload_mbps, fup_reference_gb) VALUES (1, 'Standard', 2500, 'plano-10M', 10, 2, 100)`).run();
  db.prepare(`INSERT INTO clients (id, client_code, full_name) VALUES (1, 'C0001', 'Joao Silva')`).run();
  db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username, fup_cycle_day) VALUES (1, 1, 1, 2500, 'active', 'skn001', 1)`).run();
  const today = new Date(Date.now() - 3_600_000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, 1, ?, ?)').run(today, 5e9, 80e9);

  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'supersecret', fullName: 'Admin' } });
  admin = setup.json().token;
  await app.inject({
    method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${admin}` },
    payload: { username: 'operator', password: 'operator-pw-1', fullName: 'Operador', role: 'operator' }
  });
  operator = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operator-pw-1' } })).json().token;
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

const call = (token: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

test('o operador lê a configuração, o histórico e o consumo, mas não grava', async () => {
  const settings = await call(operator, 'GET', '/api/fup/settings');
  expect(settings.statusCode).toBe(200);
  expect(settings.json().settings.find((s: { key: string }) => s.key === 'limiar_aviso_percent')).toMatchObject({ value: '80', default: '80' });
  expect((await call(operator, 'GET', '/api/fup/history')).statusCode).toBe(200);
  expect((await call(operator, 'PUT', '/api/fup/settings', { changes: { limiar_aviso_percent: '70' } })).statusCode).toBe(403);
  expect((await call(operator, 'POST', '/api/fup/settings/limiar_aviso_percent/reset')).statusCode).toBe(403);
  const usage = (await call(operator, 'GET', '/api/fup/services/1')).json();
  expect(usage.usage).toMatchObject({ username: 'skn001', downloadBytes: 80e9, uploadBytes: 5e9, state: 'NORMAL' });
  expect(Math.round(usage.usage.percent)).toBe(85);
});

test('configuração apresenta o fuso observado na última passagem do router', async () => {
  db.prepare("INSERT INTO job_runs (job, status, summary_json) VALUES ('network_enforcement', 'ok', ?)")
    .run(JSON.stringify({ fupQueues: { clockZone: 'UTC', clockMismatch: true } }));
  const result = (await call(operator, 'GET', '/api/fup/settings')).json();
  expect(result.routerClock).toEqual({ clockZone: 'UTC', clockMismatch: true });
  expect(result.settings.some((row: { key: string }) => row.key === 'fup_aplicacao_metodo')).toBe(false);
  expect((await call(admin, 'PUT', '/api/fup/settings', { changes: { fup_aplicacao_metodo: 'QUEUE' } })).statusCode).toBe(400);
});

test('a pré-visualização conta com a configuração candidata e não grava', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM fup_settings_history').get();
  const preview = await call(admin, 'POST', '/api/fup/preview', { changes: { limiar_limitacao_percent: '85' } });
  expect(preview.json()).toEqual({ current: { aviso: 1, limitados: 0 }, candidate: { aviso: 0, limitados: 1 } });
  expect(db.prepare('SELECT COUNT(*) AS n FROM fup_settings_history').get()).toEqual(before);
  expect((await call(admin, 'POST', '/api/fup/preview', { changes: { canal_aviso: 'EMAIL' } })).json().errors.canal_aviso).toMatch(/email/);
});

test('o administrador grava, com histórico e motivo, e repõe o default', async () => {
  const saved = await call(admin, 'PUT', '/api/fup/settings', { changes: { limiar_aviso_percent: '70' }, reason: 'teste' });
  expect(saved.json().changed).toEqual(['limiar_aviso_percent']);
  const invalid = await call(admin, 'PUT', '/api/fup/settings', { changes: { limiar_aviso_percent: '100' } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().errors.limiar_aviso_percent).toMatch(/menor/);
  expect((await call(admin, 'POST', '/api/fup/settings/limiar_aviso_percent/reset')).json().changed).toEqual(['limiar_aviso_percent']);
  const history = (await call(admin, 'GET', '/api/fup/history?key=limiar_aviso_percent')).json().history;
  expect(history.map((h: { newValue: string }) => h.newValue)).toEqual(['80', '70']);
  expect(history[1]).toMatchObject({ changedBy: 'admin', reason: 'teste' });
});

test('campos FUP do plano: só o administrador os muda', async () => {
  const plan = { name: 'Standard', downloadSpeed: '10 Mbps', uploadSpeed: '2 Mbps', monthlyPriceCve: 2500, routerProfile: 'plano-10M', downloadMbps: 10, uploadMbps: 2 };
  await call(operator, 'PUT', '/api/plans/1', { ...plan, fupReferenceGb: 5, fupPeakPercent: 10 });
  expect((await call(admin, 'GET', '/api/plans/1')).json()).toMatchObject({ fupReferenceGb: 100, fupPeakPercent: null });
  await call(admin, 'PUT', '/api/plans/1', { ...plan, fupReferenceGb: 300, fupPeakPercent: 40 });
  expect((await call(admin, 'GET', '/api/plans/1')).json()).toMatchObject({ fupReferenceGb: 300, fupPeakPercent: 40 });
  await call(admin, 'PUT', '/api/plans/1', plan);
  expect((await call(admin, 'GET', '/api/plans/1')).json()).toMatchObject({ fupReferenceGb: 300, fupPeakPercent: 40 });
});

test('plafond do serviço: só o administrador o muda, com auditoria; vazio volta a herdar', async () => {
  const url = '/api/fup/services/1/plafond';
  expect((await call(operator, 'PUT', url, { referenceGb: 500 })).statusCode).toBe(403);
  expect((await call(admin, 'PUT', url, { referenceGb: -1 })).statusCode).toBe(400);
  expect((await call(admin, 'PUT', '/api/fup/services/999999/plafond', { referenceGb: 5 })).statusCode).toBe(404);
  const saved = (await call(admin, 'PUT', url, { referenceGb: 500 })).json();
  expect(saved.usage).toMatchObject({ referenceGb: 500, serviceReferenceGb: 500, inheritedReferenceGb: 300 });
  const audit = db.prepare("SELECT summary, metadata_json AS metadata FROM audit_logs WHERE action = 'fup.plafond' ORDER BY id DESC LIMIT 1").get() as { summary: string; metadata: string };
  expect(audit.summary).toBe('Plafond do serviço 1: herda → 500 GB');
  expect(JSON.parse(audit.metadata)).toEqual({ antes: null, depois: 500 });
  expect((await call(admin, 'PUT', url, { referenceGb: null })).json().usage).toMatchObject({ referenceGb: 300, serviceReferenceGb: null });
});

test('ação ao limite: bloquear recusa uma mensagem que cite a janela de pico', async () => {
  const windowed = 'Caro {nome}, entre as {inicio} e as {fim} fica a {pico}%.';
  const refused = await call(admin, 'PUT', '/api/fup/settings', { changes: { acao_ao_limite: 'BLOQUEAR', mensagem_aviso: windowed } });
  expect(refused.statusCode).toBe(400);
  expect(refused.json().errors.mensagem_aviso).toMatch(/\{acao\}/);
  expect((await call(admin, 'PUT', '/api/fup/settings', { changes: { acao_ao_limite: 'BLOQUEAR', plafond_predefinido_gb: '250', dia_ciclo: '1' } })).json().changed)
    .toEqual(['plafond_predefinido_gb', 'dia_ciclo', 'acao_ao_limite']);
  expect((await call(admin, 'PUT', '/api/fup/settings', { changes: { dia_ciclo: '29' } })).statusCode).toBe(400);
  await call(admin, 'PUT', '/api/fup/settings', { changes: { acao_ao_limite: 'REDUZIR', plafond_predefinido_gb: '0', dia_ciclo: 'ATIVACAO' } });
});
