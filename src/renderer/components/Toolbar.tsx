import type { ReactNode } from 'react';

/**
 * Source of truth: PaymentsModule filter row —
 * `<div className="filter-bar">…</div>`. The slice's real toolbar class is
 * `filter-bar` (already fully styled in styles.css); no new CSS needed.
 */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}
