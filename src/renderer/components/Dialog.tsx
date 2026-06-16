import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: string;
  children: ReactNode;
  actions?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnBackdrop?: boolean;
};

const FOCUSABLE_SELECTOR =
  'a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Tracks stacked dialogs so only the topmost responds to ESC, Tab-trapping and
// backdrop clicks. Without this, opening a dialog from inside another (e.g. the
// "add items" dialog launched from the service detail modal) would let one ESC
// press close both layers at once.
const modalStack: string[] = [];

export function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  children,
  actions,
  size = 'md',
  closeOnBackdrop = true
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const stackId = useId();
  // Stash the latest onClose in a ref so the lifecycle effect can depend
  // solely on `open`. Otherwise a parent that re-renders on every keystroke
  // (passing a fresh inline `onClose`) would re-run the effect, snap focus
  // back to the first focusable element and steal the input mid-typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = cardRef.current;

    modalStack.push(stackId);
    const isTopmost = () => modalStack[modalStack.length - 1] === stackId;

    const firstFocusable = root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? root)?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKey(event: KeyboardEvent) {
      if (!isTopmost()) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === 'Tab' && root) {
        const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const idx = modalStack.lastIndexOf(stackId);
      if (idx !== -1) modalStack.splice(idx, 1);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, stackId]);

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (
          closeOnBackdrop
          && event.target === event.currentTarget
          && modalStack[modalStack.length - 1] === stackId
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className={`dialog dialog-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            type="button"
            className="dialog-close"
            onClick={onClose}
            aria-label="Fechar"
            title="Fechar"
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body
  );
}
