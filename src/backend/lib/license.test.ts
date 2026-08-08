import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { licenseClaimSchema, toIsoDate, type LicenseClaim } from '../../shared/license';
import { generateLicenseKeyPair, signLicense } from './license-signature';
import {
  activateLicense,
  clearLicenseState,
  currentLicenseStatus,
  deactivateLicense,
  ensureLicenseFile,
  licenseFilePath,
  machineFingerprint,
  resetLicenseCache
} from './license';

const keys = generateLicenseKeyPair();
const otherKeys = generateLicenseKeyPair();

const originalDataDir = process.env.ISPM_DATA_DIR;
const originalPublicKey = process.env.ISPM_LICENSE_PUBLIC_KEY;
const originalSwitch = process.env.ISPM_LICENSE;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-license-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_LICENSE_PUBLIC_KEY = keys.publicKey;
  delete process.env.ISPM_LICENSE;
  resetLicenseCache();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.ISPM_DATA_DIR;
  else process.env.ISPM_DATA_DIR = originalDataDir;
  if (originalPublicKey === undefined) delete process.env.ISPM_LICENSE_PUBLIC_KEY;
  else process.env.ISPM_LICENSE_PUBLIC_KEY = originalPublicKey;
  if (originalSwitch === undefined) delete process.env.ISPM_LICENSE;
  else process.env.ISPM_LICENSE = originalSwitch;
  resetLicenseCache();
});

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

const tokenFor = (c: LicenseClaim = claim(), privateKey = keys.privateKey) => signLicense(c, privateKey);

describe('licenciamento desligado', () => {
  test('sem chave pública configurada a app não é restringida', () => {
    delete process.env.ISPM_LICENSE_PUBLIC_KEY;
    resetLicenseCache();
    const status = currentLicenseStatus();
    expect(status.canWrite).toBe(true);
    expect(status.state).toBe('active');
    // Nem sequer cria o ficheiro de estado: a app comporta-se como sempre.
    expect(existsSync(licenseFilePath())).toBe(false);
  });

  test('ISPM_LICENSE=off desliga o licenciamento', () => {
    process.env.ISPM_LICENSE = 'off';
    resetLicenseCache();
    expect(currentLicenseStatus().canWrite).toBe(true);
  });
});

describe('ficheiro de estado', () => {
  test('o primeiro arranque cria a marca de avaliação', () => {
    const now = new Date(2026, 7, 2);
    const state = ensureLicenseFile(now);
    expect(state.trialStartedAt).toBe('2026-08-02');
    expect(state.token).toBeNull();
    expect(JSON.parse(readFileSync(licenseFilePath(), 'utf8')).trialStartedAt).toBe('2026-08-02');
  });

  test('arranques seguintes não reiniciam a avaliação', () => {
    ensureLicenseFile(new Date(2026, 7, 2));
    const later = ensureLicenseFile(new Date(2026, 7, 20));
    expect(later.trialStartedAt).toBe('2026-08-02');
  });

  test('um ficheiro corrompido recomeça a avaliação em vez de bloquear', () => {
    writeFileSync(licenseFilePath(), '{ isto não é json', 'utf8');
    resetLicenseCache();
    const status = currentLicenseStatus(new Date(2026, 7, 2));
    expect(status.state).toBe('trial');
    expect(status.canWrite).toBe(true);
  });

  test('vive fora da base de dados', () => {
    ensureLicenseFile();
    expect(path.basename(licenseFilePath())).toBe('license.json');
    expect(licenseFilePath()).toBe(path.join(dataDir, 'license.json'));
  });
});

describe('avaliação', () => {
  test('conta 30 dias a partir do primeiro arranque', () => {
    ensureLicenseFile(new Date(2026, 7, 2));
    expect(currentLicenseStatus(new Date(2026, 7, 2)).daysRemaining).toBe(30);
    expect(currentLicenseStatus(new Date(2026, 7, 20)).daysRemaining).toBe(12);
  });

  test('esgotada, bloqueia a escrita', () => {
    ensureLicenseFile(new Date(2026, 6, 1));
    const status = currentLicenseStatus(new Date(2026, 7, 2));
    expect(status.state).toBe('readonly');
    expect(status.canWrite).toBe(false);
  });
});

describe('activateLicense', () => {
  test('instala uma licença válida', () => {
    const result = activateLicense(tokenFor());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.id).toBe('LIC-2026-0001');
      expect(result.status.state).toBe('active');
    }
    expect(JSON.parse(readFileSync(licenseFilePath(), 'utf8')).token).toBeTruthy();
  });

  test('rejeita uma licença de outro emissor sem lhe tocar no estado', () => {
    activateLicense(tokenFor());
    const before = readFileSync(licenseFilePath(), 'utf8');

    const result = activateLicense(tokenFor(claim({ id: 'LIC-2026-0002' }), otherKeys.privateKey));
    expect(result.ok).toBe(false);
    // A licença boa que lá estava não pode ser substituída por uma inválida.
    expect(readFileSync(licenseFilePath(), 'utf8')).toBe(before);
  });

  test('rejeita uma licença já esgotada', () => {
    const expired = claim({ expiresAt: '2020-01-01', graceDays: 0 });
    const result = activateLicense(tokenFor(expired));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('expirou');
  });

  test('rejeita uma licença ligada a outra máquina', () => {
    const bound = claim({ bind: 'machine', fingerprint: 'maquina-alheia' });
    const result = activateLicense(tokenFor(bound));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('outra máquina');
  });

  test('aceita uma licença ligada a esta máquina', () => {
    const bound = claim({ bind: 'machine', fingerprint: machineFingerprint() });
    expect(activateLicense(tokenFor(bound)).ok).toBe(true);
  });

  test('aceita um token com quebras de linha e guarda-o normalizado', () => {
    const token = tokenFor();
    expect(activateLicense(`${token.slice(0, 30)}\n${token.slice(30)}\n`).ok).toBe(true);
    expect(JSON.parse(readFileSync(licenseFilePath(), 'utf8')).token).toBe(token);
  });
});

describe('deactivateLicense', () => {
  test('remove a licença mas não devolve a avaliação', () => {
    ensureLicenseFile(new Date(2026, 6, 1)); // avaliação já esgotada
    activateLicense(tokenFor());
    expect(currentLicenseStatus().canWrite).toBe(true);

    const status = deactivateLicense(new Date(2026, 7, 2));
    expect(status.state).toBe('readonly');
    expect(JSON.parse(readFileSync(licenseFilePath(), 'utf8')).token).toBeNull();
  });
});

describe('licença adulterada em disco', () => {
  test('editar o ficheiro à mão invalida-a', () => {
    activateLicense(tokenFor());
    const state = JSON.parse(readFileSync(licenseFilePath(), 'utf8'));
    const [payload, signature] = String(state.token).split('.');
    const forged = JSON.stringify({ ...claim(), expiresAt: '2099-01-01' });
    state.token = `${Buffer.from(forged, 'utf8').toString('base64url')}.${signature}`;
    writeFileSync(licenseFilePath(), JSON.stringify(state), 'utf8');
    resetLicenseCache();

    const status = currentLicenseStatus();
    expect(status.state).toBe('invalid');
    expect(status.canWrite).toBe(false);
    expect(payload).toBeTruthy();
  });
});

describe('machineFingerprint', () => {
  test('é estável entre chamadas', () => {
    expect(machineFingerprint()).toBe(machineFingerprint());
  });

  test('é um hash curto e opaco', () => {
    expect(machineFingerprint()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('clearLicenseState', () => {
  test('apaga o ficheiro', () => {
    ensureLicenseFile();
    clearLicenseState();
    expect(existsSync(licenseFilePath())).toBe(false);
  });
});
