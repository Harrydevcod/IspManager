import { describe, expect, test } from 'vitest';
import { missingDays } from './StoredLog';

describe('missingDays', () => {
  test('os dias sem linhas entre o mais antigo e o mais recente, atravessando o fim do mês', () => {
    const days = ['2026-11-02', '2026-10-30', '2026-10-28', '2026-10-27'].map((day) => ({ day }));
    expect(missingDays(days)).toEqual(['2026-10-29', '2026-10-31', '2026-11-01']);
  });

  test('sem buracos, ou sem dias, não falta nada', () => {
    expect(missingDays([{ day: '2026-10-09' }, { day: '2026-10-08' }])).toEqual([]);
    expect(missingDays([])).toEqual([]);
  });
});
