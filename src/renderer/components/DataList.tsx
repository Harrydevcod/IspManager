import type { ReactNode } from 'react';
import { hasTextSelection } from '../lib/textSelection';

/**
 * Source of truth: PaymentsModule's compact payment list.
 *
 * Real class names from App.tsx:
 *   container  → "payments-list"      (styles.css L736 / L741)
 *   row        → "payment-item"       (styles.css L459 / L741)
 *   row button → "payment-summary-button"  (styles.css L763)
 *   actions    → "payment-quick-actions"  (styles.css L832)
 *
 * All classes already exist in styles.css; no new CSS needed.
 * The `cell` slot maps to the caller-supplied column.cell() render function.
 * Actions are rendered in the "payment-quick-actions" div, matching the slice.
 */

type Column<T> = { cell: (row: T) => ReactNode };

type DataListProps<T> = {
  rows: T[];
  rowKey: (row: T) => string | number;
  columns: Column<T>[];
  actions?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  empty: ReactNode;
  activeKey?: string | number | null;
};

export function DataList<T>({
  rows,
  rowKey,
  columns,
  actions,
  onRowClick,
  empty,
  activeKey,
}: DataListProps<T>) {
  if (!rows.length) return <>{empty}</>;

  return (
    <div className="payments-list">
      {rows.map((row) => {
        const isActive = activeKey != null && rowKey(row) === activeKey;
        return (
        <div className={isActive ? 'payment-item active' : 'payment-item'} key={rowKey(row)}>
          <button
            type="button"
            className="payment-summary-button"
            onClick={onRowClick ? () => { if (!hasTextSelection()) onRowClick(row); } : undefined}
          >
            {columns.map((col, i) => (
              <span key={i}>{col.cell(row)}</span>
            ))}
          </button>
          {actions ? (
            <div className="payment-quick-actions">{actions(row)}</div>
          ) : null}
        </div>
        );
      })}
    </div>
  );
}
