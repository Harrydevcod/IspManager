import { Check, CloudOff, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components';

/** Uma volta da roda; o giro acaba sempre numa volta inteira. */
export const SPIN_MS = 700;
const CLOCK_MS = 10_000;

/** "agora mesmo", "há 12 s", "há 3 min", "há 2 h". */
export function syncedAgo(syncedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (seconds < 5) return 'agora mesmo';
  if (seconds < 60) return `há ${seconds} s`;
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  return `há ${Math.floor(seconds / 3600)} h`;
}

/**
 * Estado da sincronização com o router, como nas apps de sincronização na
 * nuvem: diz quando sincronizou, gira enquanto lê e um clique sincroniza já.
 * Nunca fica desativado nem troca de forma, por isso as leituras automáticas
 * não parecem um clique.
 */
export function SyncStatus({ syncing, syncedAt, error, onSync }: {
  syncing: boolean;
  syncedAt: number | null;
  error: string | null;
  onSync: () => void;
}) {
  const [spinning, setSpinning] = useState(syncing);
  const startedAt = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  // Uma leitura de 50 ms não pode piscar: a roda acaba a volta em que vai.
  useEffect(() => {
    if (syncing) {
      startedAt.current = Date.now();
      setSpinning(true);
      return;
    }
    const elapsed = Date.now() - startedAt.current;
    const left = Math.ceil(Math.max(elapsed, 1) / SPIN_MS) * SPIN_MS - elapsed;
    const timer = window.setTimeout(() => { setSpinning(false); setNow(Date.now()); }, left);
    return () => window.clearTimeout(timer);
  }, [syncing]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const failed = !spinning && error !== null;
  const icon = spinning ? <RefreshCw size={14} aria-hidden /> : failed ? <CloudOff size={14} aria-hidden /> : <Check size={14} aria-hidden />;
  const label = spinning
    ? 'A sincronizar…'
    : failed
      ? 'Sem ligação ao router'
      : syncedAt === null ? 'Por sincronizar' : `Sincronizado ${syncedAgo(syncedAt, now)}`;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={`router-sync${spinning ? ' is-syncing' : ''}${failed ? ' is-failed' : ''}`}
        leadingIcon={icon}
        onClick={onSync}
        title="Sincronizar agora"
      >
        {label}
      </Button>
      {/* Só a perda e o regresso da ligação se anunciam; a contagem não. */}
      <span className="sr-only" aria-live="polite">{failed ? 'Sem ligação ao router' : ''}</span>
    </>
  );
}
