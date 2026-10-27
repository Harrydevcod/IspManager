/** Permissões IPTV com tokens reais e utilizadores carregados da base temporária. */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { UserRole } from '../lib/auth';

let app: FastifyInstance;
let dataDir: string;
let closeDatabaseForTests: () => void;
const tokens: Partial<Record<UserRole, string>> = {};

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-iptv-roles-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  delete process.env.ISPM_AUTH;

  const { createBackendApp } = await import('../server');
  const database = await import('../db/database');
  const { signToken } = await import('../lib/auth');
  app = await createBackendApp();
  await app.ready();
  closeDatabaseForTests = database.closeDatabaseForTests;
  const db = database.getSqliteDatabase();

  const client = db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('CLT-IPTV', 'Cliente IPTV')").run();
  db.prepare(`INSERT INTO services (id, client_id, monthly_value_cve, status, pppoe_username, pppoe_password)
    VALUES (1, ?, 2500, 'active', 'skn001', 'segredo-que-nao-pode-sair')`).run(client.lastInsertRowid);
  db.prepare("INSERT INTO iptv_providers (id, name, hosts) VALUES (1, 'Fornecedor', 'iptv.example.com')").run();
  for (const role of ['admin', 'operator', 'technician'] as const) {
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (username, password_hash, full_name, role, active)
      VALUES (?, 'unused-test-password-hash', ?, ?, 1)`).run(role, role, role);
    tokens[role] = signToken({ id: Number(lastInsertRowid), username: role, fullName: role, role });
  }
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

const mark: InjectOptions = { method: 'PUT', url: '/api/services/1/iptv', payload: { iptvVpn: true, iptvProviderId: null } };
const create: InjectOptions = { method: 'POST', url: '/api/iptv/providers', payload: { name: 'Outro fornecedor', hosts: 'other.example.com' } };
const update: InjectOptions = { method: 'PUT', url: '/api/iptv/providers/1', payload: { name: 'Fornecedor alterado', hosts: 'new.example.com' } };
const reads: InjectOptions[] = [{ url: '/api/iptv/providers' }, { url: '/api/iptv/status' }];
const validate: InjectOptions = { url: '/api/iptv/validate' };
const infra: InjectOptions = { url: '/api/iptv/infra' };
const requestAs = (role: UserRole, options: InjectOptions) => app.inject({ ...options, headers: { authorization: `Bearer ${tokens[role]}` } });

test('todas as rotas IPTV exigem autenticação', async () => {
  for (const options of [mark, create, update, ...reads, validate, infra]) {
    expect([options.url, (await app.inject(options)).statusCode]).toEqual([options.url, 401]);
  }
});

test('o técnico lê o estado e fornecedores, mas não altera marcas nem consulta o router', async () => {
  for (const options of reads) expect((await requestAs('technician', options)).statusCode).toBe(200);
  for (const options of [mark, create, update, validate, infra]) {
    expect([options.url, (await requestAs('technician', options)).statusCode]).toEqual([options.url, 403]);
  }
});

test('o operador marca serviços e valida a origem; fornecedores e infraestrutura são de administrador', async () => {
  expect((await requestAs('operator', mark)).statusCode).toBe(200);
  // Sem router configurado, o 409 prova que a autorização deixou chegar à guarda de rede.
  expect((await requestAs('operator', validate)).statusCode).toBe(409);
  for (const options of [create, update, infra]) expect((await requestAs('operator', options)).statusCode).toBe(403);
});

test('o administrador gere fornecedores e passa a guarda de permissões da infraestrutura', async () => {
  expect((await requestAs('admin', create)).statusCode).toBe(201);
  expect((await requestAs('admin', update)).statusCode).toBe(200);
  expect((await requestAs('admin', mark)).statusCode).toBe(200);
  expect((await requestAs('admin', infra)).statusCode).toBe(409);
});

test('o estado autenticado nunca inclui a senha PPPoE do serviço', async () => {
  await requestAs('admin', mark);
  const response = await requestAs('technician', { url: '/api/iptv/status' });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain('skn001');
  expect(response.body).not.toContain('segredo-que-nao-pode-sair');
  expect(response.body).not.toMatch(/password|senha/i);
});
