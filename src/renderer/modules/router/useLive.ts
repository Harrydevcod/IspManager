import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '../../lib/auth';

/** Igual ao painel Operação: o router é lido ao vivo, só enquanto a aba está à vista. */
const POLL_MS = 30_000;

/**
 * Lê um endpoint enquanto `active`. Cada efeito tem a sua bandeira: em
 * StrictMode a montagem dupla não deixa o pedido antigo escrever no estado.
 */
export function useLive<T>(url: string, active: boolean, intervalMs = POLL_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((current) => current + 1), []);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = () => {
      setLoading(true);
      authFetch(url)
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          const body = await response.json() as T;
          if (alive) { setData(body); setError(null); }
        })
        .catch(() => { if (alive) setError('Não foi possível ler o router.'); })
        .finally(() => { if (alive) setLoading(false); });
    };
    read();
    const timer = window.setInterval(read, intervalMs);
    return () => { alive = false; window.clearInterval(timer); };
  }, [url, active, tick, intervalMs]);

  return { data, error, loading, reload };
}
