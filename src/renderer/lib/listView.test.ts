import { describe, expect, test } from 'vitest';
import { nextSortState, paginateRows, sortRows } from './listView';

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
