import type { ReactNode } from 'react';

/** Filter row used across modules (Pagamentos/Stock/Clientes/etc.) - renders the `.filter-bar` shell defined in styles.css. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `filter-bar ${className}` : 'filter-bar'}>{children}</div>;
}
