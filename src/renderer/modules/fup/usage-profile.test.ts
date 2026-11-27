import { describe, expect, test } from 'vitest';
import { dailyAverage, groupByMonth, groupByYear, usageFigures, type UsageDay } from './usage-profile';

const d = (day: string, down: number, up = 0): UsageDay => ({ day, downBytes: down, upBytes: up });

describe('agregações do consumo', () => {
  test('mês e ano, com a passagem de ano, do mais recente para o mais antigo', () => {
    const daily = [d('2025-12-30', 1, 1), d('2025-12-31', 2), d('2026-01-01', 4, 1)];
    expect(groupByMonth(daily).map((p) => [p.key, p.downBytes, p.upBytes, p.days, p.start, p.end])).toEqual([
      ['2026-01', 4, 1, 1, '2026-01-01', '2026-01-01'],
      ['2025-12', 3, 1, 2, '2025-12-30', '2025-12-31']
    ]);
    expect(groupByYear(daily).map((p) => [p.key, p.downBytes + p.upBytes])).toEqual([['2026', 5], ['2025', 4]]);
  });

  test('a média conta só os dias medidos', () => {
    expect(dailyAverage({ downBytes: 30, upBytes: 0, days: 3 })).toBe(10);
    expect(dailyAverage({ downBytes: 0, upBytes: 0, days: 0 })).toBe(0);
  });

  test('perfil: média, pico, dias úteis e fim de semana, tendência', () => {
    // 2026-11-23 é segunda; 28 e 29 são sábado e domingo.
    const daily = [d('2026-11-23', 10), d('2026-11-24', 20), d('2026-11-28', 40), d('2026-11-29', 30), d('2026-01-01', 999)];
    const f = usageFigures(daily, [130, 100, 100, 100, 500], '2026-11-29');
    expect(f.avgDaily).toBe(25); // o dia de janeiro fica fora dos 90 dias
    expect(f.peak).toEqual({ day: '2026-11-28', bytes: 40 });
    expect(f.weekdayAvg).toBe(15);
    expect(f.weekendAvg).toBe(35);
    expect(f.trendPercent).toBe(30); // 130 contra a média dos 3 anteriores (100); o quinto não entra
  });

  test('sem histórico não há tendência nem pico', () => {
    const f = usageFigures([], [50], '2026-11-29');
    expect(f).toEqual({ avgDaily: 0, peak: null, weekdayAvg: null, weekendAvg: null, trendPercent: null });
  });
});
