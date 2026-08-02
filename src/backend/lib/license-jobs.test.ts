/**
 * As tarefas em processo obedecem à mesma regra que a interface: sem direito
 * de escrita, não faturam nem contactam clientes. As cópias de segurança são a
 * exceção deliberada.
 *
 * Testa-se `licenseAllowsWrites` — a condição que o `server.ts` consulta — em
 * vez de arrancar o servidor com cada combinação, que só provaria o mesmo mais
 * devagar.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { licenseClaimSchema, toIsoDate } from '../../shared/license';
import { generateLicenseKeyPair, signLicense } from './license-signature';
import { licenseAllowsWrites, resetLicenseCache } from './license';

const keys = generateLicenseKeyPair();

const originalDataDir = process.env.ISPM_DATA_DIR;
const originalPublicKey = process.env.ISPM_LICENSE_PUBLIC_KEY;

let dataDir: string;

function writeState(trialStartedAt: string, token: string | null = null) {
  writeFileSync(
    path.join(dataDir, 'license.json'),
    JSON.stringify({ v: 1, trialStartedAt, token, activatedAt: null }),
    'utf8'
  );
  resetLicenseCache();
}

function validToken() {
  return signLicense(
    licenseClaimSchema.parse({
      v: 1,
      id: 'LIC-2026-0001',
      customer: 'Nova Tech, Lda',
      kind: 'subscricao',
      bind: 'none',
      issuedAt: toIsoDate(new Date()),
      expiresAt: toIsoDate(new Date(Date.now() + 90 * 86_400_000))
    }),
    keys.privateKey
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-license-jobs-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_LICENSE_PUBLIC_KEY = keys.publicKey;
  resetLicenseCache();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.ISPM_DATA_DIR;
  else process.env.ISPM_DATA_DIR = originalDataDir;
  if (originalPublicKey === undefined) delete process.env.ISPM_LICENSE_PUBLIC_KEY;
  else process.env.ISPM_LICENSE_PUBLIC_KEY = originalPublicKey;
  resetLicenseCache();
});

describe('licenseAllowsWrites', () => {
  test('deixa as tarefas correr durante a avaliação', () => {
    writeState(toIsoDate(new Date()));
    expect(licenseAllowsWrites()).toBe(true);
  });

  test('deixa as tarefas correr com licença válida', () => {
    writeState('2020-01-01', validToken());
    expect(licenseAllowsWrites()).toBe(true);
  });

  test('para as tarefas quando a escrita está bloqueada', () => {
    writeState('2020-01-01');
    expect(licenseAllowsWrites()).toBe(false);
  });

  test('volta a deixar correr assim que a licença é ativada, sem reiniciar', () => {
    writeState('2020-01-01');
    expect(licenseAllowsWrites()).toBe(false);

    // O tick seguinte de um job aberto tem de ver a mudança — é por isso que a
    // verificação vive dentro do tick e não no registo do temporizador.
    writeState('2020-01-01', validToken());
    expect(licenseAllowsWrites()).toBe(true);
  });

  test('sem licenciamento configurado nunca trava nada', () => {
    delete process.env.ISPM_LICENSE_PUBLIC_KEY;
    resetLicenseCache();
    writeState('2020-01-01');
    expect(licenseAllowsWrites()).toBe(true);
  });
});
