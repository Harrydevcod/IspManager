import { ArrowRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type CommandPaletteItem = {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  icon?: ReactNode;
  keywords?: string[];
  action: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  items: CommandPaletteItem[];
  placeholder?: string;
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function score(item: CommandPaletteItem, query: string): number {
  if (!query) return 1;
  const haystack = normalize([item.label, item.hint || '', ...(item.keywords || [])].join(' '));
  const needle = normalize(query);
  if (haystack.includes(needle)) return 2 + (haystack.startsWith(needle) ? 1 : 0);
  // letter-by-letter subsequence match (loose fuzzy)
  let cursor = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, cursor);
    if (next === -1) return 0;
    cursor = next + 1;
  }
  return 1;
}

export function CommandPalette({ open, onClose, items, placeholder = 'Procurar accao ou modulo...' }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    return items
      .map((item) => ({ item, weight: score(item, query) }))
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .map((entry) => entry.item);
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(filtered.length > 0 ? filtered.length - 1 : 0);
    }
  }, [filtered.length, activeIndex]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = filtered[activeIndex];
        if (item) {
          item.action();
          onClose();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, filtered, activeIndex, onClose]);

  useEffect(() => {
    if (!open) return;
    const root = listRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLLIElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  if (!open) return null;

  return createPortal(
    <div
      className="palette-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="palette-header">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>ESC</kbd>
        </header>
        <ul ref={listRef} className="palette-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="palette-empty">Sem resultados para "{query}"</li>
          ) : filtered.map((item, idx) => (
            <li
              key={item.id}
              data-active={idx === activeIndex ? 'true' : undefined}
              className={idx === activeIndex ? 'palette-item active' : 'palette-item'}
              role="option"
              aria-selected={idx === activeIndex}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => {
                item.action();
                onClose();
              }}
            >
              <span className="palette-item-icon">{item.icon || <ArrowRight size={14} />}</span>
              <div className="palette-item-meta">
                <strong>{item.label}</strong>
                {item.hint && <small>{item.hint}</small>}
              </div>
              {item.group && <span className="palette-item-group">{item.group}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  );
}
