import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '../../lib/auth';

/** Igual ao painel Operação: o router é lido ao vivo, só enquanto a aba está à vista. */
const POLL_MS = 30_000;

/**
 * Lê um endpoint enquanto `active`. `syncing` acompanha qualquer leitura,
 * automática ou pedida; `syncedAt` é a hora da última que correu bem. Cada
 * efeito tem a sua bandeira: em StrictMode a montagem dupla não deixa o pedido
 * antigo escrever no estado.
 */
export function useLive<T>(url: string, active: boolean, intervalMs = POLL_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((current) => current + 1), []);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let inFlight = false;
    const read = () => {
      if (inFlight) return;
      inFlight = true;
      setSyncing(true);
      authFetch(url)
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          const body = await response.json() as T;
          if (alive) { setData(body); setError(null); setSyncedAt(Date.now()); }
        })
        .catch(() => { if (alive) setError('Não foi possível ler o router.'); })
        .finally(() => { inFlight = false; if (alive) setSyncing(false); });
    };
    read();
    const timer = window.setInterval(read, intervalMs);
    return () => { alive = false; window.clearInterval(timer); };
  }, [url, active, tick, intervalMs]);

  return { data, error, syncing, syncedAt, reload };
}
