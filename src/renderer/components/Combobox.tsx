import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronDown, X } from 'lucide-react';

type ComboboxOption<T> = {
  key: string | number;
  code: string;
  label: string;
  hint?: string;
  raw: T;
};

type ComboboxProps<T> = {
  options: T[];
  value: string | number | null;
  onChange: (next: string | number | null) => void;
  rowKey: (row: T) => string | number;
  rowCode: (row: T) => string;
  rowLabel: (row: T) => string;
  rowHint?: (row: T) => string | undefined;
  placeholder?: string;
  emptyLabel?: string;
  searchPlaceholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
};

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function Combobox<T>({
  options,
  value,
  onChange,
  rowKey,
  rowCode,
  rowLabel,
  rowHint,
  placeholder = 'Selecionar...',
  emptyLabel = 'Sem resultados',
  searchPlaceholder = 'Pesquisar codigo ou nome',
  allowClear = true,
  disabled = false,
  id,
  ariaLabel
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const items = useMemo<ComboboxOption<T>[]>(
    () => options.map((row) => ({
      key: rowKey(row),
      code: rowCode(row),
      label: rowLabel(row),
      hint: rowHint?.(row),
      raw: row
    })),
    [options, rowKey, rowCode, rowLabel, rowHint]
  );

  const selected = useMemo(
    () => (value === null || value === undefined ? null : items.find((item) => item.key === value) ?? null),
    [items, value]
  );

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return items;
    return items.filter((item) => {
      const haystack = `${normalize(item.code)} ${normalize(item.label)} ${item.hint ? normalize(item.hint) : ''}`;
      return haystack.includes(q);
    });
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [filtered, open]);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      const handle = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(handle);
    }
  }, [open]);

  function commit(next: ComboboxOption<T>) {
    onChange(next.key);
    setOpen(false);
    setQuery('');
  }

  function clear() {
    onChange(null);
    setQuery('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(filtered.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const next = filtered[activeIndex];
      if (next) commit(next);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }

  return (
    <div className={`combobox${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`} ref={containerRef}>
      <button
        type="button"
        id={id}
        className="combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((s) => !s)}
      >
        {selected ? (
          <span className="combobox-value">
            <span className="combobox-value-code">{selected.code || '—'}</span>
            <span className="combobox-value-label">{selected.label}</span>
          </span>
        ) : (
          <span className="combobox-placeholder">{placeholder}</span>
        )}
        <span className="combobox-actions">
          {allowClear && selected && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              className="combobox-clear"
              aria-label="Limpar selecao"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clear();
              }}
            >
              <X size={12} aria-hidden />
            </span>
          )}
          <ChevronDown size={14} aria-hidden className="combobox-chevron" />
        </span>
      </button>

      {open && (
        <div className="combobox-popover" role="dialog">
          <div className="combobox-search">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={filtered[activeIndex] ? `${listboxId}-${filtered[activeIndex].key}` : undefined}
            />
          </div>
          <div className="combobox-listbox" id={listboxId} role="listbox">
            <div className="combobox-row combobox-head" aria-hidden="true">
              <span>Código</span>
              <span>Nome</span>
            </div>
            {filtered.length === 0 ? (
              <p className="combobox-empty">{emptyLabel}</p>
            ) : (
              filtered.map((item, index) => {
                const isSelected = selected?.key === item.key;
                const isActive = index === activeIndex;
                return (
                  <div
                    role="option"
                    id={`${listboxId}-${item.key}`}
                    key={item.key}
                    aria-selected={isSelected}
                    className={`combobox-row combobox-option${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      commit(item);
                    }}
                  >
                    <span className="combobox-code">{item.code || '—'}</span>
                    <span className="combobox-label">
                      <strong>{item.label}</strong>
                      {item.hint && <small>{item.hint}</small>}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
