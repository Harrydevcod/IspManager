import type { ReactNode } from 'react';

type CardProps = {
  eyebrow?: string;
  title?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
};

/**
 * Source of truth: Dashboard primary panel —
 * `<div className="primary-panel"><div className="section-heading">
 *  <p className="eyebrow">…</p><h2>…</h2></div>…</div>`.
 * Eyebrow + title sit directly inside `.section-heading` (no inner wrapper);
 * optional `actions` render after the title to match the slice's heading row.
 */
export function Card({ eyebrow, title, actions, className, children }: CardProps) {
  return (
    <div className={`primary-panel${className ? ` ${className}` : ''}`}>
      {(eyebrow || title || actions) && (
        <div className="section-heading">
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          {title ? <h2>{title}</h2> : null}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
