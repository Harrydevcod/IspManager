import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import * as adminNetwork from '../lib/admin-network';
import * as routeros from '../lib/routeros';

vi.mock('../lib/network-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/network-sync')>()),
  requestNetworkSync: vi.fn()
}));

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let requestNetworkSync: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-iptv-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  requestNetworkSync = (await import('../lib/network-sync')).requestNetworkSync as unknown as ReturnType<typeof vi.fn>;

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  requestNetworkSync.mockClear();
  db.exec(`
    DROP TRIGGER IF EXISTS reject_iptv_audit;
    DELETE FROM audit_logs;
    DELETE FROM job_runs;
    DELETE FROM services;
    DELETE FROM iptv_providers;
    DELETE FROM clients;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

function seedService(): number {
  const client = db.prepare("INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-IPTV', 'Cliente IPTV', 'active')").run();
  return Number(db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, activation_date, due_day, status, pppoe_username)
    VALUES (?, 2500, '2026-01-15', 10, 'active', 'skn001')
  `).run(client.lastInsertRowid).lastInsertRowid);
}

const createProvider = (hosts: string, name = 'Fornecedor A') =>
  app.inject({ method: 'POST', url: '/api/iptv/providers', payload: { name, hosts } });

function rejectAudit(): void {
  db.exec(`CREATE TRIGGER reject_iptv_audit BEFORE INSERT ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'Auditoria indisponível'); END;`);
}

describe('iptv routes', () => {
  test('falha na auditoria da marca reverte o serviço e não pede a passagem', async () => {
    const serviceId = seedService();
    const before = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    rejectAudit();
    const response = await app.inject({ method: 'PUT', url: `/api/services/${serviceId}/iptv`, payload: { iptvVpn: true, iptvProviderId: null } });
    expect(response.statusCode).toBe(500);
    expect(db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).toEqual({ n: 0 });
    expect(requestNetworkSync).not.toHaveBeenCalled();
  });

  test('falha na auditoria da criação reverte o fornecedor e não pede a passagem', async () => {
    rejectAudit();
    const response = await createProvider('iptv.example.com');
    expect(response.statusCode).toBe(500);
    expect(db.prepare('SELECT COUNT(*) AS n FROM iptv_providers').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).toEqual({ n: 0 });
    expect(requestNetworkSync).not.toHaveBeenCalled();
  });

  test('falha na auditoria da alteração reverte o fornecedor e não pede a passagem', async () => {
    const provider = (await createProvider('iptv.example.com')).json() as { id: number };
    const before = db.prepare('SELECT * FROM iptv_providers WHERE id = ?').get(provider.id);
    const audits = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get();
    requestNetworkSync.mockClear();
    rejectAudit();
    const response = await app.inject({ method: 'PUT', url: `/api/iptv/providers/${provider.id}`, payload: { name: 'Nome alterado', hosts: 'new.example.com', active: false } });
    expect(response.statusCode).toBe(500);
    expect(db.prepare('SELECT * FROM iptv_providers WHERE id = ?').get(provider.id)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).toEqual(audits);
    expect(requestNetworkSync).not.toHaveBeenCalled();
  });

  test('PUT marca o serviço, audita antes e depois e pede a passagem', async () => {
    const serviceId = seedService();
    const response = await app.inject({ method: 'PUT', url: `/api/services/${serviceId}/iptv`, payload: { iptvVpn: true, iptvProviderId: null } });
    expect(response.statusCode).toBe(200);
    expect(db.prepare('SELECT iptv_vpn AS v FROM services WHERE id = ?').get(serviceId)).toEqual({ v: 1 });
    const audit = db.prepare("SELECT metadata_json AS m FROM audit_logs WHERE action = 'service_iptv_vpn'").get() as { m: string };
    expect(JSON.parse(audit.m)).toEqual({ before: { iptvVpn: 0, iptvProviderId: null }, after: { iptvVpn: 1, iptvProviderId: null } });
    expect(requestNetworkSync).toHaveBeenCalledTimes(1);
  });

  test('PUT dá 404 sem serviço e 400 com fornecedor inexistente ou inactivo', async () => {
    const serviceId = seedService();
    const missing = await app.inject({ method: 'PUT', url: '/api/services/99999/iptv', payload: { iptvVpn: true, iptvProviderId: null } });
    expect(missing.statusCode).toBe(404);
    const unknown = await app.inject({ method: 'PUT', url: `/api/services/${serviceId}/iptv`, payload: { iptvVpn: true, iptvProviderId: 777 } });
    expect(unknown.statusCode).toBe(400);
    const provider = (await createProvider('line.dino.ws')).json() as { id: number };
    await app.inject({ method: 'PUT', url: `/api/iptv/providers/${provider.id}`, payload: { name: 'Fornecedor A', hosts: 'line.dino.ws', active: false } });
    const inactive = await app.inject({ method: 'PUT', url: `/api/services/${serviceId}/iptv`, payload: { iptvVpn: true, iptvProviderId: provider.id } });
    expect(inactive.statusCode).toBe(400);
  });

  test('fornecedor com hosts válidos dá 201 e grava a forma canónica sem repetidos', async () => {
    const response = await createProvider('line.dino.ws\n1.2.3.4\nLINE.dino.ws\n\n8.8.8.8/24');
    expect(response.statusCode).toBe(201);
    expect((response.json() as { hosts: string }).hosts).toBe('line.dino.ws\n1.2.3.4\n8.8.8.0/24');
    expect(requestNetworkSync).toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'iptv_provider_create'").get()).toEqual({ n: 1 });
  });

  test('host inválido dá 400 com a linha na mensagem', async () => {
    const response = await createProvider('line.dino.ws\nnão é host');
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('Host inválido na linha 2: não é host');
  });

  test('mais de 50 linhas dá 400', async () => {
    const hosts = Array.from({ length: 51 }, (_, i) => `h${i}.example.com`).join('\n');
    expect((await createProvider(hosts)).statusCode).toBe(400);
  });

  test('GET /api/iptv/status lista o serviço marcado e devolve last null sem corrida', async () => {
    const serviceId = seedService();
    await app.inject({ method: 'PUT', url: `/api/services/${serviceId}/iptv`, payload: { iptvVpn: true, iptvProviderId: null } });
    const body = (await app.inject({ method: 'GET', url: '/api/iptv/status' })).json() as { targets: Array<{ serviceId: number; source: { kind: string } }>; last: unknown };
    expect(body.targets).toEqual([{ serviceId, source: expect.objectContaining({ kind: 'pppoe' }) }]);
    expect(body.last).toBeNull();
  });

  test('GET /api/iptv/status devolve o iptv da última passagem', async () => {
    db.prepare("INSERT INTO job_runs (job, status, summary_json) VALUES ('network_enforcement', 'ok', ?)").run(JSON.stringify({ iptv: { status: 'idle' } }));
    const body = (await app.inject({ method: 'GET', url: '/api/iptv/status' })).json() as { last: unknown };
    expect(body.last).toEqual({ status: 'idle' });
  });

  test('validate e infra dão 409 com o router desligado', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/iptv/validate' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/iptv/infra' })).statusCode).toBe(409);
  });

  test('PUT de fornecedor: 404 se não existe; parcial mantém o que não vem', async () => {
    const missing = await app.inject({ method: 'PUT', url: '/api/iptv/providers/99999', payload: { name: 'X' } });
    expect(missing.statusCode).toBe(404);
    const provider = (await createProvider('line.dino.ws', 'Fornecedor A')).json() as { id: number };
    const renamed = await app.inject({ method: 'PUT', url: `/api/iptv/providers/${provider.id}`, payload: { name: 'Fornecedor B' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Fornecedor B', hosts: 'line.dino.ws', active: 1 });
  });

  test('desmarcar ignora o fornecedor e grava null', async () => {
    const serviceId = seedService();
    const response = await app.inject({ method: 'PUT', url: `/api/services/${serviceId}/iptv`, payload: { iptvVpn: false, iptvProviderId: 777 } });
    expect(response.statusCode).toBe(200);
    expect(db.prepare('SELECT iptv_vpn AS v, iptv_provider_id AS p FROM services WHERE id = ?').get(serviceId)).toEqual({ v: 0, p: null });
  });

  test('status usa a corrida mais recente, manual ou periódica', async () => {
    const run = db.prepare("INSERT INTO job_runs (job, status, summary_json) VALUES (?, 'ok', ?)");
    run.run('network_enforcement', JSON.stringify({ iptv: { status: 'idle' } }));
    run.run('network_enforcement_manual', JSON.stringify({ iptv: { status: 'applied' } }));
    const body = (await app.inject({ method: 'GET', url: '/api/iptv/status' })).json() as { last: { status: string } };
    expect(body.last.status).toBe('applied');
  });

  describe('router configurado', () => {
    const config = { enabled: true, host: '192.0.2.1', port: 443, user: 'u', password: 'p', dryRun: true, intervalSeconds: 60, tlsCert: '', maxDisablesPerRun: 5 };
    afterEach(() => vi.restoreAllMocks());

    test('fora da rede de gestão dá 409 com o motivo', async () => {
      vi.spyOn(routeros, 'readRouterConfig').mockReturnValue(config);
      vi.spyOn(adminNetwork, 'detectAdminNetwork').mockResolvedValue({ state: 'offsite', checkedAt: new Date().toISOString(), detail: 'O router não respondeu.' });
      const response = await app.inject({ method: 'GET', url: '/api/iptv/infra' });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: string }).error).toContain('Fora da rede de gestão');
    });

    test('leitura que rebenta dá 502', async () => {
      vi.spyOn(routeros, 'readRouterConfig').mockReturnValue(config);
      vi.spyOn(adminNetwork, 'detectAdminNetwork').mockResolvedValue({ state: 'onsite', checkedAt: new Date().toISOString(), detail: '' });
      vi.spyOn(routeros, 'createTransport').mockReturnValue((() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as routeros.RouterTransport);
      const response = await app.inject({ method: 'GET', url: '/api/iptv/infra' });
      expect(response.statusCode).toBe(502);
    });
  });
});
