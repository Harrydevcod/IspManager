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
