import type { ReactNode } from 'react';

type EmptyStateProps = { title: string; hint?: string; action?: ReactNode };

/**
 * Source of truth: the slice's empty cases (Dashboard work queue,
 * PaymentsModule list) render `<p className="module-message">…</p>`. To
 * reproduce the exact slice look with zero new CSS, the empty state is built
 * on `module-message`; optional hint/action render inside the same block.
 */
export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <p className="module-message">
      <strong>{title}</strong>
      {hint ? <> {hint}</> : null}
      {action}
    </p>
  );
}
