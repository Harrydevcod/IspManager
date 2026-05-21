import type { ReactNode } from 'react';

/**
 * Source of truth: the Pagamentos/Stock/Clientes/etc. filter row —
 * `<div className="filter-bar">…</div>`. The class is fully styled in
 * styles.css (L638); no new CSS needed.
 *
 * NOTE: This is structurally identical to Toolbar (same class, same shell).
 * Both are preserved per the task spec — see Self-review/concerns in Task 4
 * delivery report for the duplication assessment.
 * Renders the same `filter-bar` shell as `Toolbar.tsx`; the two are intentionally separate per the plan (they diverge in usage at wiring) — keep their class in sync.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}
