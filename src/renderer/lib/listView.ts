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

/** O dado bruto por que uma coluna ordena: ISO, escudos, rank — nunca o texto formatado. */
export type SortValue = string | number | null | undefined;

export type SortableColumn<T> = {
  header: string;
  sortValue?: (row: T) => SortValue;
};

function isEmptySortValue(value: SortValue) {
  return value == null || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

function compareSortValues(a: SortValue, b: SortValue) {
  if (typeof a === 'number' && typeof b === 'number') return compareNumber(a, b);
  return compareText(String(a), String(b));
}

/**
 * Ordena pela coluna ativa (a chave é o `header`). Vazios ficam sempre no fim,
 * seja qual for a direção — um "—" nunca abre a lista. Empates resolvem-se pela
 * coluna de recurso (a ordenação por omissão da tabela) e depois pela ordem de
 * chegada.
 */
export function sortByColumns<T>(
  rows: readonly T[],
  sort: SortState<string> | null | undefined,
  columns: readonly SortableColumn<T>[],
  fallbackKey?: string
): T[] {
  const active = sort && columns.find((column) => column.header === sort.key)?.sortValue;
  if (!sort || !active) return [...rows];
  const fallback = fallbackKey && fallbackKey !== sort.key
    ? columns.find((column) => column.header === fallbackKey)?.sortValue
    : undefined;
  const direction = sort.direction === 'asc' ? 1 : -1;

  return rows
    .map((row, index) => ({ row, index, value: active(row), tie: fallback?.(row) }))
    .sort((a, b) => {
      const aEmpty = isEmptySortValue(a.value);
      const bEmpty = isEmptySortValue(b.value);
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      const primary = aEmpty ? 0 : compareSortValues(a.value, b.value) * direction;
      if (primary) return primary;
      const aTieEmpty = isEmptySortValue(a.tie);
      const bTieEmpty = isEmptySortValue(b.tie);
      if (fallback && aTieEmpty !== bTieEmpty) return aTieEmpty ? 1 : -1;
      const tie = fallback && !aTieEmpty ? compareSortValues(a.tie, b.tie) : 0;
      return tie || a.index - b.index;
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
