/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { orderDiscoveryRows } from './DiscoveryWorkspace';
import type { DiscoveryCategory, DiscoveryRow } from './discovery-api';

const row = (ip: string, category: DiscoveryCategory): DiscoveryRow => ({
  ip,
  mac: null,
  hostname: null,
  vendor: null,
  model: null,
  modelSource: null,
  modelMismatch: false,
  category,
  alive: category === 'registado' || category === 'desconhecido',
  rttMs: null,
  source: null,
  registeredAs: [],
  firstSeenAt: null,
  lastSeenAt: null
});

// Como chegam do varrimento: por endereço.
const ROWS: DiscoveryRow[] = [
  row('192.168.1.2', 'registado'),
  row('192.168.1.10', 'desconhecido'),
  row('192.168.1.30', 'reservado'),
  row('192.168.1.40', 'ausente'),
  row('192.168.1.50', 'duplicado'),
  row('192.168.1.60', 'desconhecido')
];

describe('orderDiscoveryRows', () => {
  test('por endereço ordena numericamente, não como texto', () => {
    const ips = orderDiscoveryRows(ROWS, 'todos', { key: 'ip', direction: 'asc' }).map((r) => r.ip);
    expect(ips).toEqual([
      '192.168.1.2', '192.168.1.10', '192.168.1.30', '192.168.1.40', '192.168.1.50', '192.168.1.60'
    ]);
  });

  test('por estado agrupa por urgência, e o endereço desempata', () => {
    const ordered = orderDiscoveryRows(ROWS, 'todos', { key: 'estado', direction: 'asc' });
    expect(ordered.map((r) => r.category)).toEqual([
      'desconhecido', 'desconhecido', 'duplicado', 'ausente', 'reservado', 'registado'
    ]);
    // Dentro do mesmo estado mantém-se a ordem dos endereços.
    expect(ordered.slice(0, 2).map((r) => r.ip)).toEqual(['192.168.1.10', '192.168.1.60']);
  });

  test('descendente inverte a urgência — quem está em ordem primeiro', () => {
    const ordered = orderDiscoveryRows(ROWS, 'todos', { key: 'estado', direction: 'desc' });
    expect(ordered[0].category).toBe('registado');
  });

  test('o chip de estado filtra antes de ordenar', () => {
    const ordered = orderDiscoveryRows(ROWS, 'desconhecido', { key: 'estado', direction: 'asc' });
    expect(ordered.map((r) => r.ip)).toEqual(['192.168.1.10', '192.168.1.60']);
  });
});
