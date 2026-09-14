import { describe, expect, test } from 'vitest';
import { nextSortState, paginateRows, sortByColumns, sortRows } from './listView';

type Row = {
  id: number;
  name: string;
  amount: number;
};
type RowSortKey = 'name' | 'amount';

const rows: Row[] = [
  { id: 1, name: 'Beta', amount: 20 },
  { id: 2, name: 'Alpha', amount: 10 },
  { id: 3, name: 'Gamma', amount: 20 },
  { id: 4, name: 'Delta', amount: 5 }
];

describe('listView helpers', () => {
  test('sortRows applies the active comparator without mutating the input', () => {
    const sorted = sortRows<Row, RowSortKey>(rows, { key: 'name', direction: 'asc' }, {
      name: (a, b) => a.name.localeCompare(b.name),
      amount: (a, b) => a.amount - b.amount
    });

    expect(sorted.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
    expect(rows.map((row) => row.name)).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
  });

  test('sortRows keeps equal values stable and reverses only comparator order', () => {
    const sorted = sortRows<Row, RowSortKey>(rows, { key: 'amount', direction: 'desc' }, {
      name: (a, b) => a.name.localeCompare(b.name),
      amount: (a, b) => a.amount - b.amount
    });

    expect(sorted.map((row) => row.id)).toEqual([1, 3, 2, 4]);
  });

  describe('sortByColumns', () => {
    type Client = { code: string; name: string; zone: string | null; open: number | null; due: string };
    const clients: Client[] = [
      { code: 'CL-10', name: 'Óscar', zone: 'Achada', open: 1500, due: '2026-09-01' },
      { code: 'CL-2', name: 'ana', zone: null, open: 300, due: '2026-08-15' },
      { code: 'CL-1', name: 'Bruno', zone: 'Achada', open: null, due: '2026-10-02' },
      { code: 'CL-3', name: 'Carla', zone: '', open: 300, due: '2026-07-30' }
    ];
    const columns = [
      { header: 'Código', sortValue: (c: Client) => c.code },
      { header: 'Nome', sortValue: (c: Client) => c.name },
      { header: 'Zona', sortValue: (c: Client) => c.zone },
      { header: 'Em aberto', sortValue: (c: Client) => c.open },
      { header: 'Vencimento', sortValue: (c: Client) => c.due },
      { header: 'Ações' }
    ];
    const codes = (rows: Client[]) => rows.map((c) => c.code);

    test('texto em pt: códigos numéricos e acentos', () => {
      expect(codes(sortByColumns(clients, { key: 'Código', direction: 'asc' }, columns)))
        .toEqual(['CL-1', 'CL-2', 'CL-3', 'CL-10']);
      expect(sortByColumns(clients, { key: 'Nome', direction: 'asc' }, columns).map((c) => c.name))
        .toEqual(['ana', 'Bruno', 'Carla', 'Óscar']);
    });

    test('datas ISO e números nas duas direções, sem mutar a entrada', () => {
      expect(codes(sortByColumns(clients, { key: 'Vencimento', direction: 'desc' }, columns)))
        .toEqual(['CL-1', 'CL-10', 'CL-2', 'CL-3']);
      expect(codes(clients)).toEqual(['CL-10', 'CL-2', 'CL-1', 'CL-3']);
    });

    test('vazios ficam no fim em asc e em desc', () => {
      expect(codes(sortByColumns(clients, { key: 'Em aberto', direction: 'asc' }, columns)))
        .toEqual(['CL-2', 'CL-3', 'CL-10', 'CL-1']);
      expect(codes(sortByColumns(clients, { key: 'Em aberto', direction: 'desc' }, columns)))
        .toEqual(['CL-10', 'CL-2', 'CL-3', 'CL-1']);
      expect(sortByColumns(clients, { key: 'Zona', direction: 'desc' }, columns).slice(-2).map((c) => c.zone))
        .toEqual([null, '']);
    });

    test('empate resolve-se pela coluna de recurso, sempre ascendente', () => {
      expect(codes(sortByColumns(clients, { key: 'Em aberto', direction: 'desc' }, columns, 'Código')))
        .toEqual(['CL-10', 'CL-2', 'CL-3', 'CL-1']);
      expect(codes(sortByColumns(clients, { key: 'Zona', direction: 'asc' }, columns, 'Nome')))
        .toEqual(['CL-1', 'CL-10', 'CL-2', 'CL-3']);
    });

    test('chave desconhecida ou coluna sem sortValue devolve a ordem de chegada', () => {
      expect(codes(sortByColumns(clients, { key: 'Ações', direction: 'asc' }, columns))).toEqual(codes(clients));
      expect(codes(sortByColumns(clients, { key: 'Nada', direction: 'asc' }, columns))).toEqual(codes(clients));
    });
  });

  test('nextSortState starts new columns ascending and toggles the current column', () => {
    expect(nextSortState({ key: 'name', direction: 'asc' }, 'amount')).toEqual({ key: 'amount', direction: 'asc' });
    expect(nextSortState({ key: 'name', direction: 'asc' }, 'name')).toEqual({ key: 'name', direction: 'desc' });
    expect(nextSortState({ key: 'name', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' });
  });

  test('paginateRows clamps the page and reports the displayed range', () => {
    expect(paginateRows(rows, { page: 8, pageSize: 2 })).toEqual({
      page: 2,
      pageSize: 2,
      rows: rows.slice(2, 4),
      total: 4,
      totalPages: 2,
      start: 3,
      end: 4
    });
  });

  test('paginateRows falls back to the first page when pagination input is not finite', () => {
    expect(paginateRows(rows, { page: Number.NaN, pageSize: Number.POSITIVE_INFINITY })).toEqual({
      page: 1,
      pageSize: 1,
      rows: rows.slice(0, 1),
      total: 4,
      totalPages: 4,
      start: 1,
      end: 1
    });
  });
});
