import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * O painel de operação sobrevive a uma licença expirada?
 *
 * A promessa do produto é explícita em `shared/license.ts`: uma licença
 * caducada nunca tranca o ISP fora dos dados dos clientes dele — consultar,
 * exportar e fazer cópias continuam a funcionar, só a escrita é bloqueada.
 *
 * O portão distingue leitura de escrita pelo método HTTP, por isso as duas
 * rotas novas (ambas GET) deviam passar. "Deviam" não chega: se alguém
 * converter o endpoint num POST para lhe passar filtros no body, o painel
 * deixa de abrir para um cliente com a subscrição em atraso — exatamente
 * quando ele mais precisa de ver quanto tem por cobrar. Este teste falha nesse
 * dia, com a razão à vista.
 */

let app: FastifyInstance;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-operations-license-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  // Basta uma chave presente para o licenciamento agir; o valor só é usado a
  // verificar um token, e aqui não há token nenhum.
  process.env.ISPM_LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEATESTKEYNOTUSEDFORVERIFICATION0000000000000=';

  // Avaliação começada há 60 dias, sem licença: o estado que o gate lê como
  // `readonly` — o pior caso possível para um cliente.
  const trialStartedAt = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(
    path.join(dataDir, 'license.json'),
    JSON.stringify({ v: 1, trialStartedAt, token: null, activatedAt: null }, null, 2),
    'utf8'
  );

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_LICENSE_PUBLIC_KEY;
});

describe('estado da operação com a licença em leitura-apenas', () => {
  test('a instalação está mesmo em readonly (senão o resto não prova nada)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/license' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabled).toBe(true);
    expect(body.state).toBe('readonly');
    expect(body.canWrite).toBe(false);
  });

  test('o painel continua a abrir', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports/operations' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('severity');
  });

  test('o PDF mensal continua a exportar', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports/operations.pdf' });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('mas escrever continua bloqueado — a régua a que as leituras acima são comparadas', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/reports/data-quality/dismiss',
      payload: { clientIdA: 1, clientIdB: 2 }
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().license.state).toBe('readonly');
  });
});
