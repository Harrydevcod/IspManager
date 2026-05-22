import type { CSSProperties, ReactNode } from 'react';

type DataTableAlign = 'start' | 'center' | 'end';

type DataTableColumn<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  align?: DataTableAlign;
  className?: string;
};

type DataTableProps<T> = {
  rows: T[];
  rowKey: (row: T) => string | number;
  columns: DataTableColumn<T>[];
  gridTemplateColumns: string;
  actions?: (row: T) => ReactNode;
  actionsHeader?: string;
  actionsWidth?: string;
  empty: ReactNode;
  className?: string;
};

function alignClass(align: DataTableAlign = 'start') {
  return `data-table-align-${align}`;
}

export function DataTable<T>({
  rows,
  rowKey,
  columns,
  gridTemplateColumns,
  actions,
  actionsHeader = 'Ações',
  actionsWidth = '92px',
  empty,
  className
}: DataTableProps<T>) {
  if (!rows.length) return <>{empty}</>;

  const template = actions ? `${gridTemplateColumns} ${actionsWidth}` : gridTemplateColumns;
  const gridStyle: CSSProperties = { gridTemplateColumns: template };

  return (
    <div className={`data-table${className ? ` ${className}` : ''}`} role="table">
      <div className="data-table-head" role="row" style={gridStyle}>
        {columns.map((column) => (
          <span
            key={column.header}
            className={`data-table-heading ${alignClass(column.align)}`}
            role="columnheader"
          >
            {column.header}
          </span>
        ))}
        {actions && (
          <span className="data-table-heading data-table-align-end" role="columnheader">
            {actionsHeader}
          </span>
        )}
      </div>
      {rows.map((row) => (
        <div className="data-table-row" role="row" style={gridStyle} key={rowKey(row)}>
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
            <div className="data-table-actions" data-label={actionsHeader} role="cell">
              {actions(row)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
