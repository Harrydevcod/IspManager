import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type Size = 'sm' | 'md';

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  size?: Size;
};

/** Editorial empty state. Icon in a pill chip, display-font title, optional description + CTA. */
export function EmptyState({ icon: Icon, title, description, action, size = 'md' }: EmptyStateProps) {
  return (
    <div className={`empty-state empty-state-${size}`} role="status">
      {Icon ? (
        <div className="empty-state-icon" aria-hidden>
          <Icon size={size === 'sm' ? 18 : 26} strokeWidth={1.5} />
        </div>
      ) : null}
      <div className="empty-state-body">
        <p className="empty-state-title">{title}</p>
        {description ? <p className="empty-state-description">{description}</p> : null}
      </div>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
