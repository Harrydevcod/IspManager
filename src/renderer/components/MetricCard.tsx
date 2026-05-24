import type { LucideIcon } from 'lucide-react';

type MetricCardProps = { icon: LucideIcon; label: string; value: string; trend?: string };

/**
 * Source of truth: Dashboard metric card —
 * `<article className="metric-card"><Icon size={20}/><span>{label}</span>
 *  <strong>{value}</strong><small>{trend}</small></article>`.
 */
export function MetricCard({ icon: Icon, label, value, trend }: MetricCardProps) {
  return (
    <article className="metric-card">
      <Icon size={20} aria-hidden />
      <span>{label}</span>
      <strong>{value}</strong>
      {trend ? <small>{trend}</small> : null}
    </article>
  );
}
