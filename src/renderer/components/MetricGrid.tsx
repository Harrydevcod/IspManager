import type { ReactNode } from 'react';

type MetricGridProps = { label: string; children: ReactNode };

/**
 * Source of truth: Dashboard —
 * `<section className="metric-grid" aria-label="Indicadores">`.
 */
export function MetricGrid({ label, children }: MetricGridProps) {
  return (
    <section className="metric-grid" aria-label={label}>
      {children}
    </section>
  );
}
