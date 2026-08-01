import { describe, expect, test } from 'vitest';
import { CV_ISLANDS, canonicalIsland, isKnownIsland } from './islands';

describe('canonicalIsland', () => {
  test('devolve a própria grafia oficial de cada ilha', () => {
    for (const island of CV_ISLANDS) {
      expect(canonicalIsland(island)).toBe(island);
      expect(isKnownIsland(island)).toBe(true);
    }
  });

  test('reconhece as grafias que aparecem em folhas de cálculo', () => {
    expect(canonicalIsland('Sao Vicente')).toBe('São Vicente');
    expect(canonicalIsland('  sao   vicente ')).toBe('São Vicente');
    expect(canonicalIsland('SÃO VICENTE')).toBe('São Vicente');
    expect(canonicalIsland('S. Vicente')).toBe('São Vicente');
    expect(canonicalIsland('S.Antão')).toBe('Santo Antão');
    expect(canonicalIsland('santo antao')).toBe('Santo Antão');
    expect(canonicalIsland('Boavista')).toBe('Boa Vista');
    expect(canonicalIsland('Ilha do Sal')).toBe('Sal');
    expect(canonicalIsland('ilha de santiago')).toBe('Santiago');
  });

  test('não inventa uma ilha para o que não reconhece', () => {
    expect(canonicalIsland('Xpto')).toBeNull();
    expect(canonicalIsland('')).toBeNull();
    expect(canonicalIsland('Mindelo')).toBeNull();
  });
});
