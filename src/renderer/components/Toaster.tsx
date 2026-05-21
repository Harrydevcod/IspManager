import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ToastTone = 'success' | 'error' | 'info';
type Toast = { id: number; tone: ToastTone; message: string };

type ToastContextValue = {
  toast: (message: string, tone?: ToastTone) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      toast: (message: string) => {
        if (typeof console !== 'undefined') console.warn('[toast] no provider:', message);
      }
    };
  }
  return ctx;
}

const ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info
};

const TOAST_DURATION_MS = 4000;
let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, tone: ToastTone = 'info') => {
    nextId += 1;
    const id = nextId;
    setToasts((prev) => [...prev, { id, tone, message }]);
    const timer = setTimeout(() => dismiss(id), TOAST_DURATION_MS);
    timersRef.current.set(id, timer);
  }, [dismiss]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {typeof document !== 'undefined' && createPortal(
        <div className="toaster" role="region" aria-label="Notificacoes" aria-live="polite">
          {toasts.map((t) => {
            const Icon = ICONS[t.tone];
            return (
              <div key={t.id} className={`toast toast-${t.tone}`} role="status">
                <Icon size={16} className="toast-icon" />
                <span className="toast-message">{t.message}</span>
                <button
                  type="button"
                  className="toast-close"
                  onClick={() => dismiss(t.id)}
                  aria-label="Fechar notificacao"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}
