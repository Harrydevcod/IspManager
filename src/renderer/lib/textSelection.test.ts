/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { hasTextSelection } from './textSelection';

function stubSelection(value: { isCollapsed: boolean; text: string } | null) {
  vi.spyOn(window, 'getSelection').mockReturnValue(
    value === null
      ? null
      : ({ isCollapsed: value.isCollapsed, toString: () => value.text } as unknown as Selection)
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasTextSelection', () => {
  test('texto realmente selecionado conta', () => {
    stubSelection({ isCollapsed: false, text: '192.168.1.23' });
    expect(hasTextSelection()).toBe(true);
  });

  test('clique simples não conta', () => {
    stubSelection({ isCollapsed: true, text: '' });
    expect(hasTextSelection()).toBe(false);
  });

  test('seleção não colapsada mas só com espaços não conta', () => {
    // Acontece ao clicar entre dois elementos: o browser dá um range que não é
    // colapsado, mas não há texto nenhum para copiar — a linha tem de abrir.
    stubSelection({ isCollapsed: false, text: '   ' });
    expect(hasTextSelection()).toBe(false);
  });

  test('sem seleção nenhuma não rebenta', () => {
    stubSelection(null);
    expect(hasTextSelection()).toBe(false);
  });
});
