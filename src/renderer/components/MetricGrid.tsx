import type { ReactNode } from 'react';

type MetricGridProps = { label: string; children: ReactNode; className?: string };

/**
 * Source of truth: Dashboard —
 * `<section className="metric-grid" aria-label="Indicadores">`.
 */
export function MetricGrid({ label, children, className }: MetricGridProps) {
  return (
    <section className={className ? `metric-grid ${className}` : 'metric-grid'} aria-label={label}>
      {children}
    </section>
  );
}
