import { Columns3 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button';

type ColumnPickerProps = {
  headers: readonly string[];
  hidden: ReadonlySet<string>;
  onToggle: (header: string) => void;
  onReset: () => void;
};

/**
 * Escolher as colunas que se veem. Um painel que cai do botão, não um diálogo:
 * a escolha faz-se a olhar para a tabela, e a tabela muda a cada clique.
 */
export function ColumnPicker({ headers, hidden, onToggle, onReset }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const shown = headers.length - hidden.size;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="column-picker" ref={rootRef}>
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<Columns3 size={15} aria-hidden />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        Colunas
        {hidden.size > 0 ? <span className="column-picker-count">{shown}/{headers.length}</span> : null}
      </Button>
      {open && (
        <div className="column-picker-panel" id={panelId} role="group" aria-label="Colunas visíveis">
          {headers.map((header) => {
            const visible = !hidden.has(header);
            return (
              <label className="column-picker-item" key={header}>
                <input
                  type="checkbox"
                  checked={visible}
                  // A última visível não se desliga: uma tabela sem colunas não se lê.
                  disabled={visible && shown === 1}
                  onChange={() => onToggle(header)}
                />
                <span>{header}</span>
              </label>
            );
          })}
          <button
            type="button"
            className="column-picker-reset"
            disabled={hidden.size === 0}
            onClick={onReset}
          >
            Mostrar todas
          </button>
        </div>
      )}
    </div>
  );
}
