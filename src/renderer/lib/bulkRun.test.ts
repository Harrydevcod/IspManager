import { describe, expect, test } from 'vitest';
import { runBulk, summarizeBulk } from './bulkRun';

describe('runBulk', () => {
  test('runs every item in order and counts successes', async () => {
    const seen: number[] = [];
    const result = await runBulk([1, 2, 3], async (n) => { seen.push(n); });
    expect(seen).toEqual([1, 2, 3]);
    expect(result).toEqual({ ok: 3, failed: 0 });
  });

  test('a failing item does not abort the rest', async () => {
    const seen: number[] = [];
    const result = await runBulk([1, 2, 3], async (n) => {
      seen.push(n);
      if (n === 2) throw new Error('boom');
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(result).toEqual({ ok: 2, failed: 1 });
  });
});

describe('summarizeBulk', () => {
  test('formats all-ok, all-failed and mixed outcomes', () => {
    expect(summarizeBulk({ ok: 3, failed: 0 }, 'notificados')).toBe('3 notificados com sucesso.');
    expect(summarizeBulk({ ok: 0, failed: 2 }, 'notificados')).toBe('Falhou em 2 notificados.');
    expect(summarizeBulk({ ok: 2, failed: 1 }, 'notificados')).toBe('2 notificados; 1 falhou(aram).');
  });
});
