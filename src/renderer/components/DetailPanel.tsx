import { X } from 'lucide-react';
import type { ReactNode } from 'react';

type DetailPanelProps = {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
  id?: string;
  actionsClassName?: string;
};

/**
 * Inline detail panel rendered alongside a list (the `client-detail` shell
 * from PaymentsModule's `selectedPayment`). This is NOT a backdrop modal -
 * it has no focus trap, no scroll lock, no ESC handler. For overlay flows
 * use `Dialog`.
 */
export function DetailPanel({ title, onClose, children, eyebrow, actions, className, id, actionsClassName }: DetailPanelProps) {
  return (
    <div className={className ? `client-detail ${className}` : 'client-detail'} id={id}>
      <div className="module-header">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
        </div>
        <div className={actionsClassName ? `inline-actions ${actionsClassName}` : 'inline-actions'}>
          {actions}
          <button type="button" title="Fechar" aria-label="Fechar" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
