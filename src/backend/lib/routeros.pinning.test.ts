import { createServer, type Server } from 'node:tls';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createTransport,
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

beforeAll(async () => {
  server = createServer(
    { cert: TEST_ROUTER_LEAF_PEM + TEST_ROUTER_CA_PEM, key: TEST_ROUTER_KEY_PEM },
    (socket) => {
      socket.on('data', () => {
        const body = JSON.stringify([{ version: '7.24.2 (stable)', 'board-name': 'hEX S' }]);
        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
        );
      });
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
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
