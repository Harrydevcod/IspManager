import type { LucideIcon } from 'lucide-react';

type MetricCardTone = 'neutral' | 'success' | 'revenue' | 'danger' | 'info';
type MetricCardProps = { icon: LucideIcon; label: string; value: string; trend?: string; tone?: MetricCardTone };

/**
 * Source of truth: Dashboard metric card —
 * `<article className="metric-card"><Icon size={20}/><span>{label}</span>
 *  <strong>{value}</strong><small>{trend}</small></article>`.
 */
export function MetricCard({ icon: Icon, label, value, trend, tone = 'neutral' }: MetricCardProps) {
  return (
    <article className={`metric-card metric-card-${tone}`}>
      <Icon size={20} aria-hidden />
      <span>{label}</span>
      <strong>{value}</strong>
      {trend ? <small>{trend}</small> : null}
    </article>
  );
}
