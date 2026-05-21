import { X } from 'lucide-react';
import type { ReactNode } from 'react';

type DetailModalProps = {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
  id?: string;
  actionsClassName?: string;
};

/** Inline detail panel (the `client-detail` shell from PaymentsModule's `selectedPayment`), NOT a backdrop modal — the `DetailModal` name is retained per the plan/Task 6 contract. */
export function DetailModal({ title, onClose, children, eyebrow, actions, className, id, actionsClassName }: DetailModalProps) {
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
            <X size={16} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
