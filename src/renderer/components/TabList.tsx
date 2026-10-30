import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from './Button';

export type TabItem<T extends string> = { id: T; label: ReactNode };

type TabListProps<T extends string> = {
  /** Os ids saem daqui: `${idPrefix}-tab-${id}` na aba, `${idPrefix}-panel-${id}` no painel que ela controla. */
  idPrefix: string;
  label: string;
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** O aspeto de segmento (`segmented-tabs`), para vistas dentro de uma aba. */
  segmented?: boolean;
};

/**
 * Abas com o comportamento do padrão WAI-ARIA: só a escolhida entra no Tab, as setas
 * dão a volta nas pontas, Home e End vão aos extremos, e escolher pelo teclado leva o foco.
 */
export function TabList<T extends string>({ idPrefix, label, tabs, value, onChange, className, segmented }: TabListProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const current = tabs.findIndex((tab) => tab.id === value);
    const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : -1;
    if (next === -1) return;
    event.preventDefault();
    const id = tabs[next].id;
    onChange(id);
    // Pelo id, não por ref: há quem volte a montar a lista ao mudar de vista (Incidentes).
    queueMicrotask(() => document.getElementById(`${idPrefix}-tab-${id}`)?.focus());
  }

  const listClass = [segmented && 'segmented-tabs', className].filter(Boolean).join(' ') || undefined;
  return (
    <div className={listClass} role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <Button
            key={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            variant="ghost"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className={segmented ? `segmented-tab${selected ? ' is-active' : ''}` : undefined}
            onClick={() => onChange(tab.id)}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </Button>
        );
      })}
    </div>
  );
}
