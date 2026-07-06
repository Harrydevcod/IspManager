import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { SortDirection, SortState } from '../lib/listView';
import type { SelectAllState } from '../lib/useRowSelection';

type DataTableAlign = 'start' | 'center' | 'end';

export type DataTableSelection = {
  isSelected: (key: string | number) => boolean;
  onToggleRow: (key: string | number) => void;
  headerState: SelectAllState;
  onToggleAll: () => void;
};

function SelectCheckbox({ checked, indeterminate, onChange, label }: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="data-table-check"
      checked={checked}
      aria-label={label}
      ref={(node) => { if (node) node.indeterminate = Boolean(indeterminate); }}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

type DataTableColumn<T, K extends string = string> = {
  header: string;
  cell: (row: T) => ReactNode;
  align?: DataTableAlign;
  className?: string;
  sortKey?: K;
  defaultDirection?: SortDirection;
};

type DataTableProps<T, K extends string = string> = {
  rows: T[];
  rowKey: (row: T) => string | number;
  columns: DataTableColumn<T, K>[];
  gridTemplateColumns: string;
  actions?: (row: T) => ReactNode;
  actionsHeader?: string;
  actionsWidth?: string;
  empty: ReactNode;
  className?: string;
  stickyHeader?: boolean;
  sort?: SortState<K>;
  onSortChange?: (sort: SortState<K>) => void;
  onRowClick?: (row: T) => void;
  activeKey?: string | number | null;
  selection?: DataTableSelection;
};

function alignClass(align: DataTableAlign = 'start') {
  return `data-table-align-${align}`;
}

function sortIcon(direction: SortDirection | undefined) {
  if (direction === 'asc') return <ChevronUp size={13} aria-hidden />;
  if (direction === 'desc') return <ChevronDown size={13} aria-hidden />;
  return <ChevronsUpDown size={13} aria-hidden />;
}

export function DataTable<T, K extends string = string>({
  rows,
  rowKey,
  columns,
  gridTemplateColumns,
  actions,
  actionsHeader = 'Ações',
  actionsWidth = '92px',
  empty,
  className,
  stickyHeader = false,
  sort,
  onSortChange,
  onRowClick,
  activeKey,
  selection
}: DataTableProps<T, K>) {
  if (!rows.length) return <>{empty}</>;

  const selectColumn = selection ? '44px ' : '';
  const template = `${selectColumn}${actions ? `${gridTemplateColumns} ${actionsWidth}` : gridTemplateColumns}`;
  const gridStyle: CSSProperties = { gridTemplateColumns: template };
  const classes = ['data-table'];
  if (stickyHeader) classes.push('has-sticky-head');
  if (className) classes.push(className);

  function activateRow(row: T) {
    onRowClick?.(row);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, row: T) {
    if (!onRowClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateRow(row);
    }
  }

  return (
    <div className={classes.join(' ')} role="table">
      <div className="data-table-head" role="row" style={gridStyle}>
        {selection && (
          <span className="data-table-heading data-table-check-cell" role="columnheader">
            <SelectCheckbox
              checked={selection.headerState === 'all'}
              indeterminate={selection.headerState === 'some'}
              onChange={selection.onToggleAll}
              label="Selecionar tudo nesta página"
            />
          </span>
        )}
        {columns.map((column) => {
          const isSorted = Boolean(column.sortKey && sort && sort.key === column.sortKey);
          return (
            <span
              key={column.header}
              className={`data-table-heading ${alignClass(column.align)}`}
              role="columnheader"
              aria-sort={isSorted && sort ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
            >
              {column.sortKey && onSortChange ? (
                <button
                  type="button"
                  className={`data-table-sort${isSorted ? ' is-active' : ''}`}
                  onClick={() => {
                    const direction = isSorted && sort
                      ? (sort.direction === 'asc' ? 'desc' : 'asc')
                      : column.defaultDirection || 'asc';
                    onSortChange({ key: column.sortKey as K, direction });
                  }}
                >
                  <span>{column.header}</span>
                  {sortIcon(isSorted && sort ? sort.direction : undefined)}
                </button>
              ) : column.header}
            </span>
          );
        })}
        {actions && (
          <span className="data-table-heading data-table-align-end data-table-actions-heading" role="columnheader">
            {actionsHeader}
          </span>
        )}
      </div>
      {rows.map((row) => {
        const key = rowKey(row);
        const isRowSelected = selection ? selection.isSelected(key) : false;
        return (
        <div
          className={`data-table-row${onRowClick ? ' is-interactive' : ''}${activeKey != null && key === activeKey ? ' is-active' : ''}${isRowSelected ? ' is-selected' : ''}`}
          role="row"
          style={gridStyle}
          key={key}
          tabIndex={onRowClick ? 0 : undefined}
          onClick={onRowClick ? () => activateRow(row) : undefined}
          onKeyDown={(event) => handleRowKeyDown(event, row)}
        >
          {selection && (
            <div className="data-table-cell data-table-check-cell" role="cell">
              <SelectCheckbox
                checked={isRowSelected}
                onChange={() => selection.onToggleRow(key)}
                label="Selecionar linha"
              />
            </div>
          )}
          {columns.map((column) => (
            <div
              className={`data-table-cell ${alignClass(column.align)}${column.className ? ` ${column.className}` : ''}`}
              data-label={column.header}
              role="cell"
              key={column.header}
            >
              {column.cell(row)}
            </div>
          ))}
          {actions && (
            <div
              className="data-table-actions"
              data-label={actionsHeader}
              role="cell"
              onClick={onRowClick ? (event) => event.stopPropagation() : undefined}
              onKeyDown={onRowClick ? (event) => event.stopPropagation() : undefined}
            >
              {actions(row)}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
