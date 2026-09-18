import { describe, expect, test } from 'vitest';
import { documentStatusLabel } from './documents';

describe('estado no documento', () => {
  test('le-se em portugues, nunca o codigo da base', () => {
    expect(documentStatusLabel('pending')).toBe('PENDENTE');
    expect(documentStatusLabel('partial')).toBe('PARCIAL');
    expect(documentStatusLabel('overdue')).toBe('EM ATRASO');
    expect(documentStatusLabel('cancelled')).toBe('ANULADA');
  });

  test('estado desconhecido nao vaza para a fatura', () => {
    expect(documentStatusLabel(null)).toBe('-');
    expect(documentStatusLabel('whatever')).toBe('-');
  });
});
