/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DataTable } from './DataTable';

type Row = { id: number; ip: string };

const ROWS: Row[] = [{ id: 1, ip: '192.168.1.23' }];

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(onRowClick: (row: Row) => void): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <DataTable
        rows={ROWS}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
        gridTemplateColumns="1fr"
        columns={[{ header: 'IP', cell: (row: Row) => row.ip }]}
        empty={<p>sem linhas</p>}
      />
    );
  });
  return container;
}

function stubSelection(text: string) {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: text === '',
    toString: () => text
  } as unknown as Selection);
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('DataTable: ordenar pelo cabeçalho', () => {
  type Money = { id: number; name: string; amount: number | null };
  const MONEY: Money[] = [
    { id: 1, name: 'Beta', amount: 200 },
    { id: 2, name: 'alfa', amount: null },
    { id: 3, name: 'Gama', amount: 900 }
  ];

  function mountSortable() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <DataTable
          rows={MONEY}
          rowKey={(row) => row.id}
          gridTemplateColumns="1fr 1fr 1fr"
          defaultSort={{ key: 'Nome', direction: 'asc' }}
          columns={[
            { header: 'Nome', sortValue: (row: Money) => row.name, cell: (row: Money) => row.name },
            { header: 'Valor', sortValue: (row: Money) => row.amount, defaultDirection: 'desc', cell: (row: Money) => String(row.amount ?? '—') },
            { header: 'Nota', cell: () => 'x' }
          ]}
          empty={<p>sem linhas</p>}
        />
      );
    });
    return container;
  }

  const names = (el: HTMLElement) =>
    [...el.querySelectorAll('.data-table-row')].map((row) => row.firstElementChild!.textContent);
  const heading = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll<HTMLElement>('[role="columnheader"]')].find((h) => h.textContent === label)!;

  test('parte da ordenação por omissão e alterna asc/desc no clique', () => {
    const el = mountSortable();
    expect(names(el)).toEqual(['alfa', 'Beta', 'Gama']);
    expect(heading(el, 'Nome').getAttribute('aria-sort')).toBe('ascending');

    act(() => heading(el, 'Nome').querySelector('button')!.click());
    expect(names(el)).toEqual(['Gama', 'Beta', 'alfa']);
    expect(heading(el, 'Nome').getAttribute('aria-sort')).toBe('descending');
  });

  test('o primeiro clique respeita defaultDirection e os vazios ficam no fim', () => {
    const el = mountSortable();
    act(() => heading(el, 'Valor').querySelector('button')!.click());
    expect(names(el)).toEqual(['Gama', 'Beta', 'alfa']);
    expect(heading(el, 'Nome').getAttribute('aria-sort')).toBe('none');

    act(() => heading(el, 'Valor').querySelector('button')!.click());
    expect(names(el)).toEqual(['Beta', 'Gama', 'alfa']);
  });

  test('coluna sem sortValue não tem botão', () => {
    const el = mountSortable();
    expect(heading(el, 'Nota').querySelector('button')).toBeNull();
    expect(heading(el, 'Nota').hasAttribute('aria-sort')).toBe(false);
  });
});

describe('DataTable: copiar texto de uma linha clicável', () => {
  test('clique sem seleção abre a linha', () => {
    const onRowClick = vi.fn();
    const el = mount(onRowClick);
    stubSelection('');

    act(() => {
      el.querySelector<HTMLElement>('.data-table-row')!.click();
    });

    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  test('clique depois de selecionar texto não abre a linha', () => {
    // O utilizador arrastou sobre o IP para o copiar: o `click` que se segue não
    // pode abrir o detalhe por cima da seleção.
    const onRowClick = vi.fn();
    const el = mount(onRowClick);
    stubSelection('192.168.1.23');

    act(() => {
      el.querySelector<HTMLElement>('.data-table-row')!.click();
    });

    expect(onRowClick).not.toHaveBeenCalled();
  });

  test('Enter abre a linha mesmo com texto selecionado', () => {
    // O teclado nunca deixa seleção atrás de si; se deixasse, a linha ficava presa.
    const onRowClick = vi.fn();
    const el = mount(onRowClick);
    stubSelection('192.168.1.23');

    act(() => {
      el.querySelector<HTMLElement>('.data-table-row')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });
});
