/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { splitTracks, useColumnVisibility, visibleColumns } from './columnVisibility';

describe('splitTracks', () => {
  test('não parte dentro de parênteses', () => {
    expect(splitTracks(' 112px minmax(0, 1.4fr)  minmax(96px, calc(1fr + 2px)) 84px '))
      .toEqual(['112px', 'minmax(0, 1.4fr)', 'minmax(96px, calc(1fr + 2px))', '84px']);
  });
});

describe('visibleColumns', () => {
  const columns = [{ header: 'A' }, { header: 'B' }, { header: 'C' }];

  test('tira a coluna e a faixa dela', () => {
    expect(visibleColumns(columns, '1fr 2fr 3fr', new Set(['B'])))
      .toEqual({ columns: [{ header: 'A' }, { header: 'C' }], gridTemplateColumns: '1fr 3fr' });
  });

  test('faixas que não batem com as colunas: não mexe', () => {
    expect(visibleColumns(columns, 'repeat(3, 1fr)', new Set(['B'])).columns).toHaveLength(3);
  });
});

describe('useColumnVisibility', () => {
  const KEY = 'test.hiddenColumns';
  const HEADERS = ['A', 'B', 'C'];
  let root: Root | null = null;
  let api: ReturnType<typeof useColumnVisibility> | null = null;

  function Probe({ defaults }: { defaults?: string[] }) {
    api = useColumnVisibility(KEY, HEADERS, defaults);
    return null;
  }

  function mount(defaults?: string[]) {
    act(() => {
      root?.unmount();
      root = createRoot(document.createElement('div'));
      root.render(<Probe defaults={defaults} />);
    });
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    localStorage.clear();
  });

  test('sem escolha guardada vale a proposta; depois a escolha persiste', () => {
    mount(['C']);
    expect([...api!.hidden]).toEqual(['C']);
    act(() => api!.toggle('A'));
    mount(['C']);
    expect([...api!.hidden].sort()).toEqual(['A', 'C']);
    act(() => api!.reset());
    mount(['C']);
    expect(api!.hidden.size).toBe(0);
  });

  test('ignora colunas que já não existem', () => {
    localStorage.setItem(KEY, JSON.stringify(['B', 'Antiga']));
    mount();
    expect([...api!.hidden]).toEqual(['B']);
  });

  test('a última coluna visível não se esconde', () => {
    mount();
    act(() => api!.toggle('A'));
    act(() => api!.toggle('B'));
    act(() => api!.toggle('C'));
    expect([...api!.hidden].sort()).toEqual(['A', 'B']);
  });
});
