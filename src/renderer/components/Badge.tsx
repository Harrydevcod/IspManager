import type { ReactNode } from 'react';

type Tone = 'success' | 'danger' | 'info' | 'neutral' | 'accent' | 'warn';

/**
 * Source of truth: PaymentsModule status pill
 * `<span className={`payment-status ${status}`}>`. That class is
 * payments-specific; a generic, reusable `.badge` + tone modifiers are added
 * additively to styles.css (token-based) so other modules share one look.
 */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
