/**
 * O portão de licenciamento. Metade destes testes existe para provar o que o
 * portão NÃO bloqueia: se algum dia alguém alargar a regra, é aqui que parte.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { licenseClaimSchema, toIsoDate, type LicenseClaim } from '../../shared/license';
import { generateLicenseKeyPair, signLicense } from '../lib/license-signature';
import { resetLicenseCache } from '../lib/license';

const keys = generateLicenseKeyPair();

let app: FastifyInstance;
let dataDir: string;
let closeDatabaseForTests: () => void;

function writeLicenseState(state: { trialStartedAt: string; token?: string | null }) {
  writeFileSync(
    path.join(dataDir, 'license.json'),
    JSON.stringify({ v: 1, activatedAt: null, token: null, ...state }),
    'utf8'
  );
  resetLicenseCache();
}

/** Avaliação esgotada e sem licença: o pior estado possível. */
function readonlyInstall() {
  writeLicenseState({ trialStartedAt: '2020-01-01' });
}

function freshTrial() {
  writeLicenseState({ trialStartedAt: toIsoDate(new Date()) });
}

function claim(overrides: Partial<LicenseClaim> = {}): LicenseClaim {
  return licenseClaimSchema.parse({
    v: 1,
    id: 'LIC-2026-0001',
    customer: 'Nova Tech, Lda',
    kind: 'subscricao',
    bind: 'none',
    issuedAt: toIsoDate(new Date()),
    expiresAt: toIsoDate(new Date(Date.now() + 365 * 86_400_000)),
    ...overrides
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-license-gate-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  process.env.ISPM_AUTH = 'off';
  process.env.ISPM_LICENSE_PUBLIC_KEY = keys.publicKey;

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  process.env.ISPM_LICENSE_PUBLIC_KEY = keys.publicKey;
  delete process.env.ISPM_LICENSE;
  resetLicenseCache();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_LICENSE_PUBLIC_KEY;
  resetLicenseCache();
});

describe('o que o portão bloqueia', () => {
  test('escritas devolvem 402 com o estado da licença', async () => {
    readonlyInstall();
    const response = await app.inject({ method: 'POST', url: '/api/clients', payload: {} });

    expect(response.statusCode).toBe(402);
    expect(response.json().license.state).toBe('readonly');
    expect(response.json().error).toContain('exportação');
  });

  test.each(['PUT', 'PATCH', 'DELETE'])('bloqueia também %s', async (method) => {
    readonlyInstall();
    const response = await app.inject({ method: method as 'PUT', url: '/api/clients/1', payload: {} });
    expect(response.statusCode).toBe(402);
  });

  test('deixa passar assim que há licença', async () => {
    writeLicenseState({ trialStartedAt: '2020-01-01', token: signLicense(claim(), keys.privateKey) });
    const response = await app.inject({ method: 'POST', url: '/api/clients', payload: {} });
    // 400 da validação do corpo — o que importa é ter passado o portão.
    expect(response.statusCode).toBe(400);
  });
});

describe('o que o portão nunca bloqueia', () => {
  beforeEach(() => readonlyInstall());

  test('consultar os dados dos clientes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(response.statusCode).toBe(200);
  });

  test('gerar documentos', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/payments/999999/invoice.pdf' });
    expect(response.statusCode).not.toBe(402);
  });

  test('criar uma cópia de segurança', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/backups', payload: {} });
    expect(response.statusCode).not.toBe(402);
  });

  test('restaurar uma cópia de segurança', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/backups/restore', payload: {} });
    expect(response.statusCode).not.toBe(402);
  });

  test('autenticar-se', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(response.statusCode).not.toBe(402);
  });

  test('ativar uma licença', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/license',
      payload: { token: signLicense(claim(), keys.privateKey) }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe('active');
  });

  test('remover a licença desta máquina', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/license' });
    expect(response.statusCode).toBe(200);
  });

  test('consultar a saúde do processo', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /api/license', () => {
  test('expõe o estado sem exigir sessão', async () => {
    freshTrial();
    const response = await app.inject({ method: 'GET', url: '/api/license' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'trial', canWrite: true, enabled: true });
    expect(response.json().daysRemaining).toBe(30);
  });

  test('descreve a licença ativa sem devolver o token', async () => {
    const token = signLicense(claim(), keys.privateKey);
    writeLicenseState({ trialStartedAt: '2020-01-01', token });
    const body = await app.inject({ method: 'GET', url: '/api/license' }).then((r) => r.json());

    expect(body.license).toMatchObject({ id: 'LIC-2026-0001', customer: 'Nova Tech, Lda', kind: 'subscricao' });
    // O token é a credencial: descreve-se a licença, nunca se reenvia a chave.
    expect(JSON.stringify(body)).not.toContain(token.slice(0, 40));
    expect(body.token).toBeUndefined();
  });
});

describe('POST /api/license', () => {
  beforeEach(() => freshTrial());

  test('recusa um token de outro emissor', async () => {
    const foreign = generateLicenseKeyPair();
    const response = await app.inject({
      method: 'POST',
      url: '/api/license',
      payload: { token: signLicense(claim(), foreign.privateKey) }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('não confere');
  });

  test('recusa um pedido sem token', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/license', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe('licenciamento desligado', () => {
  test('sem chave pública o portão é inerte', async () => {
    readonlyInstall();
    delete process.env.ISPM_LICENSE_PUBLIC_KEY;
    resetLicenseCache();

    const response = await app.inject({ method: 'POST', url: '/api/clients', payload: {} });
    expect(response.statusCode).not.toBe(402);
    expect((await app.inject({ method: 'GET', url: '/api/license' })).json().enabled).toBe(false);
  });
});
