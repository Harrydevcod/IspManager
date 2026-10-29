import { MoreHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';

export type RowActionItem = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
};

export type RowActionGroup = {
  label: string;
  items: RowActionItem[];
};

type RowActionsMenuProps = {
  groups: RowActionGroup[];
  title?: string;
};

export function RowActionsMenu({ groups, title = 'Mais ações' }: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ up: boolean; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const visibleGroups = groups
    .map((group) => ({ ...group, items: group.items }))
    .filter((group) => group.items.length > 0);

  // Abre para cima quando não há espaço em baixo (linhas no fundo da lista),
  // e limita a altura ao espaço disponível com scroll interno como rede.
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const trigger = rootRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const margin = 8;
    const spaceBelow = window.innerHeight - trigger.bottom - margin;
    const spaceAbove = trigger.top - margin;
    const needed = panel.scrollHeight + 6;
    const up = needed > spaceBelow && spaceAbove > spaceBelow;
    setPlacement({ up, maxHeight: Math.max(160, Math.floor(up ? spaceAbove : spaceBelow)) });
  }, [open]);

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

  if (visibleGroups.length === 0) return null;

  return (
    <div className="row-actions-menu" ref={rootRef}>
      <Button
        variant="icon"
        size="sm"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
      >
        <MoreHorizontal size={16} aria-hidden />
      </Button>
      {open && (
        <div
          className={`row-actions-menu-panel${placement?.up ? ' is-up' : ''}`}
          role="menu"
          ref={panelRef}
          style={placement ? { maxHeight: placement.maxHeight } : undefined}
        >
          <MenuGroups groups={visibleGroups} onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function MenuGroups({ groups, onPick }: { groups: RowActionGroup[]; onPick: () => void }) {
  return groups.map((group) => (
    <div className="row-actions-menu-group" key={group.label}>
      <span className="row-actions-menu-label">{group.label}</span>
      {group.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`row-actions-menu-item${item.danger ? ' is-danger' : ''}`}
          disabled={item.disabled}
          title={item.title}
          onClick={(event) => { event.stopPropagation(); onPick(); item.onClick(); }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  ));
}

/** O mesmo painel, aberto no ponto do botão direito em vez de por baixo de um gatilho. */
export function ContextMenu({ x, y, groups, onClose }: RowActionsMenuProps & { x: number; y: number; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState({ x, y });

  // Não sai do ecrã: perto da borda abre para o lado de dentro.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const margin = 8;
    setPoint({
      x: Math.min(x, window.innerWidth - panel.offsetWidth - margin),
      y: Math.min(y, window.innerHeight - panel.offsetHeight - margin)
    });
    panel.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const visibleGroups = groups.filter((group) => group.items.length > 0);
  if (visibleGroups.length === 0) return null;
  return (
    <div
      className="row-actions-menu-panel is-context"
      role="menu"
      ref={panelRef}
      style={{ left: point.x, top: point.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuGroups groups={visibleGroups} onPick={onClose} />
    </div>
  );
}
