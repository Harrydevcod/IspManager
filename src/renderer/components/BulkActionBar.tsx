import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

type BulkActionBarProps = {
  count: number;
  /** Botões de ação em lote (à direita). */
  children: ReactNode;
  onClear: () => void;
  noun?: { one: string; many: string };
};

/** Barra de ações em massa — aparece quando há linhas selecionadas. */
export function BulkActionBar({ count, children, onClear, noun = { one: 'selecionado', many: 'selecionados' } }: BulkActionBarProps) {
  if (count === 0) return null;
  return (
    <div className="bulk-action-bar" role="region" aria-label="Ações em massa">
      <span className="bulk-action-count">
        <strong>{count}</strong> {count === 1 ? noun.one : noun.many}
      </span>
      <div className="bulk-action-buttons">
        {children}
        <Button variant="icon" size="sm" title="Limpar seleção" aria-label="Limpar seleção" onClick={onClear}>
          <X size={16} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
