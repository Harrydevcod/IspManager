import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  eyebrow?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
};

type ConfirmContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

/**
 * Promise-based replacement for the native `window.confirm`. Resolves `true`
 * when the user confirms, `false` on cancel/backdrop/ESC — so call sites keep
 * the familiar `if (!(await confirm({...}))) return;` shape.
 *
 * Without a provider it degrades to `window.confirm` so isolated renders and
 * tests still work (mirrors `useToast`).
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    return (options) => Promise.resolve(typeof window !== 'undefined' ? window.confirm(options.title) : true);
  }
  return ctx.confirm;
}

type PendingConfirm = { options: ConfirmOptions; resolve: (value: boolean) => void };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // If a confirm is already open, resolve it as cancelled before replacing.
      setPending((current) => {
        current?.resolve(false);
        return { options, resolve };
      });
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const opts = pending?.options;

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {pending && opts && (
        <Dialog
          open
          onClose={() => settle(false)}
          eyebrow={opts.eyebrow}
          title={opts.title}
          size="sm"
          actions={
            <>
              <Button variant="secondary" onClick={() => settle(false)}>
                {opts.cancelLabel ?? 'Cancelar'}
              </Button>
              <Button variant={opts.tone === 'danger' ? 'danger' : 'primary'} onClick={() => settle(true)}>
                {opts.confirmLabel ?? 'Confirmar'}
              </Button>
            </>
          }
        >
          {opts.message ? <p className="confirm-dialog-message">{opts.message}</p> : null}
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}
