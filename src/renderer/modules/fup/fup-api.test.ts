import { describe, expect, test } from 'vitest';
import { formatGb, summarizeByClient, usageTone, type FupUsage } from './fup-api';

const thresholds = { aviso: 80, limitacao: 100 };

const row = (overrides: Partial<FupUsage>): FupUsage => ({
  serviceId: 1, clientId: 1, username: 'ana', planName: 'Standard', referenceGb: 100, peakPercent: 50,
  cycleStart: '2026-10-10', cycleEnd: '2026-11-09', period: '2026-10',
  downloadBytes: 0, uploadBytes: 0, totalBytes: 0, percent: 0, state: 'NORMAL', limitedNow: false,
  ...overrides
});

describe('uso justo no ecrã', () => {
  test('verde até ao aviso, laranja até à limitação, vermelho acima', () => {
    expect(usageTone(79.9, thresholds)).toBe('success');
    expect(usageTone(80, thresholds)).toBe('warn');
    expect(usageTone(100, thresholds)).toBe('warn');
    expect(usageTone(100.1, thresholds)).toBe('danger');
  });

  test('GB em base 1024³, em pt-PT', () => {
    expect(formatGb(1.5 * 1024 ** 3)).toBe('1,5 GB');
  });

  test('por cliente: soma o consumo, fica com a maior % e marca limitado', () => {
    const map = summarizeByClient([
      row({ serviceId: 1, username: 'ana-1', totalBytes: 10, percent: 40 }),
      row({ serviceId: 2, username: 'ana-2', totalBytes: 5, percent: 90, state: 'LIMITADO' }),
      row({ serviceId: 3, clientId: 2, username: 'rui', referenceGb: 0, totalBytes: 7 })
    ], thresholds);
    expect(map.get(1)).toMatchObject({ usernames: ['ana-1', 'ana-2'], totalBytes: 15, percent: 90, limited: true });
    expect(map.get(2)).toMatchObject({ usernames: ['rui'], percent: null, limited: false });
  });
});
