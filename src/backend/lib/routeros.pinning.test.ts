import { createServer, type Server } from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createTransport,
  diagnoseRouter,
  fetchRouterCertificate,
  fingerprintOf,
  testConnection,
  type RouterConfig
} from './routeros';
import { TEST_ROUTER_CA_PEM, TEST_ROUTER_KEY_PEM, TEST_ROUTER_LEAF_PEM } from './routerosTestCerts';

/**
 * Um router de mentira que apresenta a mesma forma de certificado que o
 * MikroTik: uma folha assinada por uma autoridade local, as duas enviadas no
 * aperto de mão.
 *
 * Este ficheiro existe por causa de um defeito real: fixava-se só o certificado
 * do router e o OpenSSL recusava-o para sempre como âncora de confiança, por a
 * folha não ser autoridade. Carregar em "Confiar neste certificado" nunca
 * resolvia nada, e a ligação ficava impossível.
 */
let server: Server;
let port: number;

function configFor(tlsCert: string): RouterConfig {
  return {
    enabled: true,
    host: '127.0.0.1',
    port,
    user: 'ispm',
    password: 'segredo',
    dryRun: true,
    intervalSeconds: 120,
    tlsCert,
    maxDisablesPerRun: 5
  };
}

/**
 * O que o router de mentira devolve em `/ip/service`. Os testes trocam isto
 * para exercitar o router fechado, o aberto, e o que recusa a leitura.
 */
let servicesReply: { status: number; rows: unknown } = { status: 200, rows: [] };

beforeAll(async () => {
  server = createServer(
    { cert: TEST_ROUTER_LEAF_PEM + TEST_ROUTER_CA_PEM, key: TEST_ROUTER_KEY_PEM },
    (socket) => {
      socket.on('data', (chunk: Buffer) => {
        const requestLine = chunk.toString('utf8').split('\r\n')[0] ?? '';
        const isServices = requestLine.includes('/ip/service');
        // Forma exata do erro do RouterOS 7: a causa vem em `detail`, o
        // `message` é só a frase do HTTP.
        const isRejectedWrite = requestLine.startsWith('PUT /rest/ppp/secret');
        const status = isRejectedWrite ? 400 : isServices ? servicesReply.status : 200;
        const body = JSON.stringify(
          isRejectedWrite
            ? { error: 400, message: 'Bad Request', detail: 'unknown parameter rate-limit' }
            : isServices ? servicesReply.rows : [{ version: '7.24.2 (stable)', 'board-name': 'hEX S' }]
        );
        socket.end(
          `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Forbidden'}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
        );
      });
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

beforeEach(() => {
  servicesReply = { status: 200, rows: [] };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fixar o certificado do router', () => {
  test('lê a cadeia inteira, não só o certificado do router', async () => {
    const read = await fetchRouterCertificate(configFor(''));
    expect(read.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    // A folha vem primeiro: é ela que identifica o router, e é a impressão
    // digital dela que o operador compara.
    expect(fingerprintOf(read.pem)).toBe(fingerprintOf(TEST_ROUTER_LEAF_PEM));
    expect(read.fingerprint).toBe(fingerprintOf(TEST_ROUTER_LEAF_PEM));
  });

  test('fixada a cadeia lida, a ligação passa a ser aceite', async () => {
    const read = await fetchRouterCertificate(configFor(''));
    const info = await testConnection(createTransport(configFor(read.pem)));
    expect(info).toEqual({ version: '7.24.2 (stable)', boardName: 'hEX S' });
  });

  test('fixar só a folha nunca chega — era este o defeito', async () => {
    await expect(testConnection(createTransport(configFor(TEST_ROUTER_LEAF_PEM))))
      .rejects.toMatchObject({ certIssue: 'untrusted' });
  });

  test('cadeia válida mas identidade errada é recusada na mesma', async () => {
    // Fixar a autoridade sozinha faz a cadeia validar — e é exatamente por isso
    // que a identidade não pode depender só dela: a impressão digital que conta
    // é a da folha, e essa não bate.
    await expect(testConnection(createTransport(configFor(TEST_ROUTER_CA_PEM))))
      .rejects.toMatchObject({ code: 'CERT_MISMATCH' });
  });
});

describe('erros do router', () => {
  // Contra o router real, os 6 secrets de teste falharam todos com "Bad
  // Request" e nada mais: o motivo que o RouterOS manda em `detail` perdia-se.
  test('a recusa leva o motivo que o RouterOS deu', async () => {
    const chain = await fetchRouterCertificate(configFor(''));
    const transport = createTransport(configFor(chain.pem));
    await expect(transport({ method: 'PUT', path: '/ppp/secret', body: { name: 'x' } }))
      .rejects.toMatchObject({ status: 400, message: 'Bad Request: unknown parameter rate-limit' });
  });
});

describe('a etapa dos serviços abertos', () => {
  async function hardeningStep(rows: unknown, status = 200) {
    const chain = await fetchRouterCertificate(configFor(''));
    servicesReply = { status, rows };
    const report = await diagnoseRouter(configFor(chain.pem));
    const step = report.steps.find((s) => s.id === 'hardening');
    return { report, step: step! };
  }

  test('router fechado: a etapa passa e o diagnóstico fica verde', async () => {
    const { report, step } = await hardeningStep([
      { name: 'telnet', port: 23, disabled: 'true' },
      { name: 'www-ssl', port: 443, certificate: 'ispm-cert' },
      { name: 'winbox', port: 8291, address: '192.168.2.0/24' }
    ]);
    expect(report.ok).toBe(true);
    expect(step.status).toBe('ok');
  });

  test('router aberto: avisa e dá o comando, sem falhar a ligação', async () => {
    const { report, step } = await hardeningStep([
      { name: 'telnet', port: 23 },
      { name: 'www', port: 80 },
      { name: 'api-ssl', port: 8729, certificate: 'none' },
      { name: 'winbox', port: 8291 }
    ]);
    // A ligação funciona: e isso que o `ok` quer dizer. O aviso nao o derruba.
    expect(report.ok).toBe(true);
    expect(report.version).toBe('7.24.2 (stable)');
    expect(step.status).toBe('warn');
    expect(step.detail).toContain('telnet');
    expect(step.detail).toContain('www');
    expect(step.command).toContain('/ip service disable telnet,www');
    expect(step.command).toContain('api-ssl');
  });

  test('sem permissão para ler os serviços fica por testar, não em falha', async () => {
    const { report, step } = await hardeningStep({ message: 'no permissions' }, 403);
    expect(report.ok).toBe(true);
    expect(step.status).toBe('skipped');
    expect(step.detail).toContain('read');
  });
});
