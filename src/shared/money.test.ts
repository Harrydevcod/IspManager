import { describe, expect, test } from 'vitest';
import {
  escudosToCentavos,
  centavosToEscudos,
  sumCentavos,
  multiplyCentavos,
  allocateCentavos,
  formatCentavos,
  formatEscudos,
  formatCompactEscudos
} from './money';

describe('conversion', () => {
  test('escudosToCentavos rounds to the centavo', () => {
    expect(escudosToCentavos(3500)).toBe(350000);
    expect(escudosToCentavos(20.5)).toBe(2050);
    expect(escudosToCentavos(0.1)).toBe(10);
    // 19.99 is not exactly representable as a float — rounding must still land on 1999.
    expect(escudosToCentavos(19.99)).toBe(1999);
    expect(escudosToCentavos(0)).toBe(0);
  });

  test('centavosToEscudos is the inverse for whole centavos', () => {
    expect(centavosToEscudos(350000)).toBe(3500);
    expect(centavosToEscudos(2050)).toBe(20.5);
    expect(centavosToEscudos(0)).toBe(0);
  });
});

describe('safe arithmetic', () => {
  test('sumCentavos is exact where float addition would drift', () => {
    // 0.10 + 0.20 in escudos drifts; in centavos it is just 10 + 20.
    expect(sumCentavos([10, 20])).toBe(30);
    expect(sumCentavos([350000, 52500, -500])).toBe(402000);
    expect(sumCentavos([])).toBe(0);
  });

  test('multiplyCentavos applies a rate and rounds (VAT 15%)', () => {
    expect(multiplyCentavos(350000, 0.15)).toBe(52500);
    // 333 * 0.15 = 49.95 → 50
    expect(multiplyCentavos(333, 0.15)).toBe(50);
  });
});

describe('allocateCentavos', () => {
  test('splits without creating or losing centavos', () => {
    const parts = allocateCentavos(100, [1, 1, 1]);
    expect(parts).toEqual([34, 33, 33]);
    expect(sumCentavos(parts)).toBe(100);
  });

  test('distributes by weight, remainder to the largest fractions', () => {
    const parts = allocateCentavos(1000, [1, 2, 1]);
    expect(sumCentavos(parts)).toBe(1000);
    expect(parts).toEqual([250, 500, 250]);
  });

  test('falls back to an even split when no weight is usable', () => {
    expect(sumCentavos(allocateCentavos(100, [0, 0, 0]))).toBe(100);
    expect(allocateCentavos(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  test('clamps negative weights and preserves the total sign', () => {
    const parts = allocateCentavos(-100, [3, 1]);
    expect(sumCentavos(parts)).toBe(-100);
    expect(parts).toEqual([-75, -25]);
  });

  test('empty weights yield an empty split', () => {
    expect(allocateCentavos(100, [])).toEqual([]);
  });
});

describe('cifrão formatting', () => {
  test('formatCentavos uses "." thousands and "$" decimal separator', () => {
    expect(formatCentavos(350000)).toBe('3.500$00');
    expect(formatCentavos(2050)).toBe('20$50');
    expect(formatCentavos(5)).toBe('0$05');
    expect(formatCentavos(0)).toBe('0$00');
    expect(formatCentavos(123456700)).toBe('1.234.567$00');
  });

  test('formatCentavos renders negatives with a leading minus', () => {
    expect(formatCentavos(-50000)).toBe('-500$00');
    expect(formatCentavos(-2050)).toBe('-20$50');
  });

  test('formatEscudos accepts fractional escudos', () => {
    expect(formatEscudos(3500)).toBe('3.500$00');
    expect(formatEscudos(3500.5)).toBe('3.500$50');
    expect(formatEscudos(0.1)).toBe('0$10');
  });

  test('formatCompactEscudos abbreviates with a trailing cifrão', () => {
    expect(formatCompactEscudos(500)).toBe('500$');
    expect(formatCompactEscudos(1500)).toBe('1.5k$');
    expect(formatCompactEscudos(12000)).toBe('12k$');
    expect(formatCompactEscudos(3_500_000)).toBe('3.5M$');
    expect(formatCompactEscudos(15_000_000)).toBe('15M$');
    expect(formatCompactEscudos(-1500)).toBe('-1.5k$');
  });
});
