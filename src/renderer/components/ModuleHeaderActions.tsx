import type { ReactElement, ReactNode } from 'react';

export type ModuleHeaderActionsProps = {
  context?: ReactNode;
  secondary?: ReactNode;
  critical?: ReactNode;
  primary?: ReactElement;
  ariaLabel?: string;
  className?: string;
};

export function ModuleHeaderActions({
  context,
  secondary,
  critical,
  primary,
  ariaLabel = 'Ações do módulo',
  className
}: ModuleHeaderActionsProps) {
  const hasCommands = Boolean(secondary || critical || primary);
  const classes = ['module-header-actions', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {context ? <div className="module-header-context">{context}</div> : null}
      {hasCommands ? (
        <div className="module-header-commands" role="group" aria-label={ariaLabel}>
          {secondary ? <div className="module-header-actions-secondary">{secondary}</div> : null}
          {critical ? <div className="module-header-actions-critical">{critical}</div> : null}
          {primary ? <div className="module-header-actions-primary">{primary}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
