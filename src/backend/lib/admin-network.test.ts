import { beforeEach, describe, expect, test, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { RouterError, type RouterConfig } from './routeros';

const { config, fetchCertificate } = vi.hoisted(() => ({ config: {
  enabled: true, host: '192.0.2.1', port: 443, user: 'ispm', password: 'segredo',
  dryRun: true, intervalSeconds: 120, tlsCert: 'pinned', maxDisablesPerRun: 5
}, fetchCertificate: vi.fn() }));
vi.mock('./routeros', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./routeros')>();
  return {
    ...actual,
    readRouterConfig: () => config,
    isRouterConfigured: (value: RouterConfig) => Boolean(value.host && value.user && value.password),
    fingerprintOf: (pem: string) => pem === 'pinned' ? 'MATCH' : pem,
    fetchRouterCertificate: fetchCertificate
  };
});

import { detectAdminNetwork, resetAdminNetworkCacheForTests } from './admin-network';

beforeEach(() => {
  resetAdminNetworkCacheForTests();
  fetchCertificate.mockReset();
  config.enabled = true;
  config.tlsCert = 'pinned';
});

describe('detectAdminNetwork', () => {
  const db = {} as Database.Database;

  test('confirma a impressão digital e partilha a verificação em cache', async () => {
    fetchCertificate.mockResolvedValue({ fingerprint: 'MATCH' });
    expect((await detectAdminNetwork(db)).state).toBe('onsite');
    expect((await detectAdminNetwork(db)).state).toBe('onsite');
    expect(fetchCertificate).toHaveBeenCalledTimes(1);
    resetAdminNetworkCacheForTests();
    await detectAdminNetwork(db);
    expect(fetchCertificate).toHaveBeenCalledTimes(2);
  });

  test('outro certificado é rede alheia', async () => {
    fetchCertificate.mockResolvedValue({ fingerprint: 'OTHER' });
    expect(await detectAdminNetwork(db)).toMatchObject({ state: 'foreign' });
  });

  test('CERT_MISMATCH é rede alheia', async () => {
    fetchCertificate.mockRejectedValue(new RouterError('mismatch', 0, undefined, 'CERT_MISMATCH'));
    expect((await detectAdminNetwork(db)).state).toBe('foreign');
  });

  test('timeout significa fora da rede', async () => {
    fetchCertificate.mockRejectedValue(new RouterError('timeout', 0, undefined, 'ETIMEDOUT'));
    expect((await detectAdminNetwork(db)).state).toBe('offsite');
  });

  test('sem configuração é desconhecido e não abre ligação', async () => {
    config.enabled = false;
    expect((await detectAdminNetwork(db)).state).toBe('unknown');
    expect(fetchCertificate).not.toHaveBeenCalled();
  });

  test('sem certificado fixado aceita o aperto de mão', async () => {
    config.tlsCert = '';
    fetchCertificate.mockResolvedValue({ fingerprint: 'OTHER' });
    expect((await detectAdminNetwork(db)).state).toBe('onsite');
  });
});
