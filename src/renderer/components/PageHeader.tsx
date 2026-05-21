import type { ReactNode } from 'react';

type PageHeaderProps = { eyebrow?: string; title: string; actions?: ReactNode };

/**
 * Source of truth: the shell topbar —
 * `<header className="topbar"><div><p className="eyebrow">…</p><h1>…</h1></div>
 *  <div className="topbar-actions">…</div></header>`.
 * Classes match the shell exactly; no new CSS needed.
 */
export function PageHeader({ eyebrow, title, actions }: PageHeaderProps) {
  return (
    <header className="topbar">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
      </div>
      {actions ? <div className="topbar-actions">{actions}</div> : null}
    </header>
  );
}
