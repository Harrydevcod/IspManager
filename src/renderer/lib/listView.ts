export type SortDirection = 'asc' | 'desc';

export type SortState<K extends string> = {
  key: K;
  direction: SortDirection;
};

export type SortComparators<T, K extends string> = Partial<Record<K, (a: T, b: T) => number>>;

export type PaginationState = {
  page: number;
  pageSize: number;
};

export type PaginatedRows<T> = PaginationState & {
  rows: T[];
  total: number;
  totalPages: number;
  start: number;
  end: number;
};

export function compareText(a: string | null | undefined, b: string | null | undefined) {
  return (a || '').localeCompare(b || '', 'pt', { sensitivity: 'base', numeric: true });
}

export function compareNumber(a: number | null | undefined, b: number | null | undefined) {
  return (a ?? 0) - (b ?? 0);
}

export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K>,
  comparators: SortComparators<T, K>
) {
  const comparator = comparators[sort.key];
  if (!comparator) return [...rows];

  const direction = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const result = comparator(a.row, b.row) * direction;
      return result || a.index - b.index;
    })
    .map((entry) => entry.row);
}

export function nextSortState<K extends string>(
  current: SortState<K>,
  key: K,
  initialDirection: SortDirection = 'asc'
): SortState<K> {
  if (current.key !== key) return { key, direction: initialDirection };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

export function paginateRows<T>(rows: readonly T[], state: PaginationState): PaginatedRows<T> {
  const total = rows.length;
  const requestedPageSize = Number.isFinite(state.pageSize) ? state.pageSize : 1;
  const requestedPage = Number.isFinite(state.page) ? state.page : 1;
  const pageSize = Math.max(1, Math.floor(requestedPageSize));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage)), totalPages);
  const startIndex = (page - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);

  return {
    page,
    pageSize,
    rows: pageRows,
    total,
    totalPages,
    start: total === 0 ? 0 : startIndex + 1,
    end: startIndex + pageRows.length
  };
}
