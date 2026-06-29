import type { KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';

type MetricCardTone = 'neutral' | 'success' | 'revenue' | 'danger' | 'info';
type MetricCardProps = {
  icon: LucideIcon;
  label: string;
  value: string;
  trend?: string;
  tone?: MetricCardTone;
  onActivate?: () => void;
};

/**
 * Source of truth: Dashboard metric card —
 * `<article className="metric-card"><Icon size={20}/><span>{label}</span>
 *  <strong>{value}</strong><small>{trend}</small></article>`.
 * Com `onActivate` vira atalho clicável (ex.: "Em atraso" → Pagamentos vencidos).
 */
export function MetricCard({ icon: Icon, label, value, trend, tone = 'neutral', onActivate }: MetricCardProps) {
  const interactive = onActivate
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onActivate();
          }
        }
      }
    : {};
  return (
    <article className={`metric-card metric-card-${tone}${onActivate ? ' metric-card-clickable' : ''}`} {...interactive}>
      <Icon size={20} aria-hidden />
      <span>{label}</span>
      <strong>{value}</strong>
      {trend ? <small>{trend}</small> : null}
    </article>
  );
}
