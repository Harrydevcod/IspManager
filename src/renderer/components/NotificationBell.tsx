import { Bell, Smartphone } from 'lucide-react';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseDate } from '../../shared/date';

/**
 * O sino: o que precisa de atenção agora e o que já aconteceu, num sítio só.
 *
 * O número é o que ainda não foi visto; abrir o painel apaga-o, mas cada entrada
 * continua por ler até ser tocada — como no telemóvel, que mostra este mesmo
 * histórico.
 */

export type NotificationNow = {
  id: string;
  severity: 'danger' | 'warn' | 'info';
  title: string;
  detail: string | null;
  section: string;
  focus: string | null;
};

export type NotificationEntry = {
  id: number;
  uid: string;
  origin: 'pc' | 'phone';
  kind: string;
  severity: 'danger' | 'warn' | 'info';
  title: string;
  detail: string | null;
  section: string | null;
  focus: string | null;
  createdAt: string;
  read: boolean;
};

export type NotificationFeed = { now: NotificationNow[]; history: NotificationEntry[]; unseen: number };

/** O que o sino precisa de saber e de fazer, igual em qualquer sítio onde apareça. */
export type NotificationBellData = {
  feed: NotificationFeed | null;
  onOpen: () => void;
  onNavigate: (section: string, focus: string | null) => void;
  onRead: (id: number) => void;
  onReadAll: () => void;
};

export type NotificationBellProps = NotificationBellData & {
  /** Menu lateral recolhido: o rótulo some e o título sai (fica a legenda do rail). */
  collapsed?: boolean;
  tipProps?: (label: string) => Record<string, unknown>;
  /** Só o ícone, para caber no canto de um cartão. */
  compact?: boolean;
};

/**
 * Os dados do sino, para ele aparecer em mais do que um sítio sem ninguém ter
 * de os passar de mão em mão. O painel da operação usa-o tal como a barra.
 */
const NotificationsContext = createContext<NotificationBellData | null>(null);
export const NotificationsProvider = NotificationsContext.Provider;
export function useNotifications(): NotificationBellData | null {
  return useContext(NotificationsContext);
}

const TONE_ORDER = { danger: 0, warn: 1, info: 2 } as const;
const noTip = () => ({});

export function NotificationBell({
  feed, collapsed = false, tipProps = noTip, compact = false, onOpen, onNavigate, onRead, onReadAll
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const now = feed?.now ?? [];
  const history = feed?.history ?? [];
  const unseen = feed?.unseen ?? 0;
  const count = now.length + unseen;
  const unread = history.filter((entry) => !entry.read).length;
  const tone = now.reduce<'danger' | 'warn' | 'info'>(
    (worst, item) => (TONE_ORDER[item.severity] < TONE_ORDER[worst] ? item.severity : worst),
    'info'
  );

  // Ctrl+Shift+N abre e fecha, como o Ctrl+K da paleta.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        toggle();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function toggle() {
    setOpen((value) => {
      if (!value) onOpen();
      return !value;
    });
  }

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function pick(section: string | null, focus: string | null, id?: number) {
    if (id !== undefined) onRead(id);
    setOpen(false);
    if (section) onNavigate(section, focus);
  }

  const label = count > 0 ? `Notificações, ${count}` : 'Notificações';
  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={`bell-trigger${compact ? ' is-compact' : ''}${open ? ' is-open' : ''}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={collapsed ? undefined : 'Notificações (Ctrl+Shift+N)'}
        {...tipProps(count > 0 ? `Notificações · ${count}` : 'Notificações')}
      >
        <Bell size={16} aria-hidden />
        {!compact && <span className="nav-label">Notificações</span>}
        {count > 0 && (
          <span className={`nav-counter nav-counter-${tone}`} aria-hidden="true">{count > 9 ? '9+' : count}</span>
        )}
      </button>
      {open && (
        <BellPanel
          anchor={buttonRef.current}
          now={now}
          history={history}
          unread={unread}
          onClose={close}
          onPick={pick}
          onReadAll={onReadAll}
        />
      )}
    </>
  );
}

type PanelProps = {
  anchor: HTMLElement | null;
  now: NotificationNow[];
  history: NotificationEntry[];
  unread: number;
  onClose: () => void;
  onPick: (section: string | null, focus: string | null, id?: number) => void;
  onReadAll: () => void;
};

function BellPanel({ anchor, now, history, unread, onClose, onPick, onReadAll }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);

  // No body: a barra lateral tem overflow próprio e prendia o painel lá dentro.
  useLayoutEffect(() => {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = Math.min(400, window.innerWidth - 32);
    setPoint({
      left: Math.max(16, Math.min(box.left, window.innerWidth - width - 16)),
      top: box.bottom + 8
    });
  }, [anchor]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchor?.contains(target)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchor, onClose]);

  if (!point) return null;
  const empty = now.length === 0 && history.length === 0;
  return createPortal(
    <div
      className="bell-panel"
      role="dialog"
      aria-label="Notificações"
      ref={panelRef}
      style={{ left: point.left, top: point.top }}
    >
      <header className="bell-head">
        <h2>Notificações</h2>
        {unread > 0 && (
          <button type="button" className="bell-link" onClick={onReadAll}>Marcar como lidas</button>
        )}
      </header>

      <div className="bell-body">
        {empty && (
          <p className="bell-empty"><Bell size={20} aria-hidden /> Tudo em ordem</p>
        )}

        {now.length > 0 && <h3 className="bell-section">Agora</h3>}
        {now.map((item) => (
          <button key={item.id} type="button" className="bell-row" onClick={() => onPick(item.section, item.focus)}>
            <span className={`bell-dot bell-dot-${item.severity}`} aria-hidden />
            <span className="bell-text">
              <span className="bell-title">{item.title}</span>
              {item.detail && <span className="bell-detail">{item.detail}</span>}
            </span>
            <span className="bell-action">Ver</span>
          </button>
        ))}

        {history.length > 0 && <h3 className="bell-section">Anteriores</h3>}
        {history.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`bell-row${entry.read ? '' : ' is-unread'}`}
            onClick={() => onPick(entry.section, entry.focus, entry.id)}
          >
            <span className={`bell-dot bell-dot-${entry.severity}${entry.read ? ' is-read' : ''}`} aria-hidden />
            <span className="bell-text">
              <span className="bell-title">{entry.title}</span>
              {entry.detail && <span className="bell-detail">{entry.detail}</span>}
            </span>
            <span className="bell-when">
              {entry.origin === 'phone' && <Smartphone size={12} aria-label="do telemóvel" />}
              {relativeTime(entry.createdAt)}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}

/** "há 5 min", "ontem 14:02", "12-11 09:30" — o recente em palavras, o resto em data. */
export function relativeTime(value: string, now: Date = new Date()): string {
  const date = parseDate(value);
  if (!date) return '';
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const time = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit' }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `ontem ${time}`;
  const day = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit' }).format(date).replace('/', '-');
  return `${day} ${time}`;
}
