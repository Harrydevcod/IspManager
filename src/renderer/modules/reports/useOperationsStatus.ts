import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '../../lib/auth';
import type { OperationsStatus } from '../../../shared/operations-status';

/** Ritmo do polling. Curto o suficiente para ser "ao vivo" numa app de desktop. */
export const OPERATIONS_POLL_MS = 30_000;

type OperationsStatusState = {
  status: OperationsStatus | null;
  error: string | null;
  loading: boolean;
  /** Instante da última resposta bem-sucedida — a UI mostra-o. */
  updatedAt: Date | null;
  refresh: () => void;
};

/**
 * Estado da operação em tempo real.
 *
 * Faz polling a cada 30 s e revalida quando a janela ganha foco — voltar à app
 * depois de registar um pagamento tem de mostrar o pagamento, não esperar pelo
 * próximo tick. Enquanto a janela está escondida o ciclo é suspenso, em vez de
 * acumular pedidos para um ecrã que ninguém está a ver.
 *
 * Uma falha de rede mantém os dados anteriores no ecrã e assinala o erro à
 * parte: um painel de monitorização a ficar em branco por causa de um pedido
 * falhado é pior do que um painel a admitir que mostra dados de há um minuto.
 */
export function useOperationsStatus(active: boolean): OperationsStatusState {
  const [status, setStatus] = useState<OperationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // Pedido em curso, para o poder abortar: sem isto uma resposta lenta podia
  // aterrar depois de uma mais recente e recuar o painel no tempo.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/reports/operations', {
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as OperationsStatus;
      if (controller.signal.aborted) return;
      setStatus(data);
      setUpdatedAt(new Date());
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error && err.message.startsWith('HTTP')
        ? 'O servidor recusou o pedido de estado da operação.'
        : 'Não foi possível ler o estado da operação.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      void load();
      timer = setInterval(() => { void load(); }, OPERATIONS_POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onFocus = () => { void load(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    start();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      inFlight.current?.abort();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, load]);

  return { status, error, loading, updatedAt, refresh: () => { void load(); } };
}
