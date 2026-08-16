import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chunk, expandRange, SWEEP_BATCH_SIZE } from '../../../../shared/ip-range';
import { suggestIpPrefix } from '../../../lib/ip';
import { createDiscoveryApi, type DiscoveryApi, type DiscoveryReport } from './discovery-api';

export type ScanProgress = { done: number; total: number } | null;

export type UseDiscovery = {
  range: string;
  setRange: (value: string) => void;
  includeRouter: boolean;
  setIncludeRouter: (value: boolean) => void;
  report: DiscoveryReport | null;
  loading: boolean;
  scanning: boolean;
  progress: ScanProgress;
  error: string | null;
  scan: () => void;
  stop: () => void;
  refresh: () => void;
};

const RANGE_STORAGE_KEY = 'ispm.discovery.range';

/**
 * O varrimento é sequencial de propósito.
 *
 * Disparar todos os lotes de uma vez daria um número único no fim e nenhuma
 * barra pelo meio — e mandaria 254 pings à rede num só fôlego. Em série, cada
 * lote que volta move a barra e dá ao botão "Parar" um sítio onde parar.
 */
export function useDiscovery(active: boolean, api: DiscoveryApi = createDiscoveryApi()): UseDiscovery {
  const [range, setRangeState] = useState(() => {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(RANGE_STORAGE_KEY) ?? '';
  });
  const [includeRouter, setIncludeRouter] = useState(true);
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    abortRef.current?.abort();
  }, []);

  const setRange = useCallback((value: string) => {
    setRangeState(value);
    if (typeof localStorage !== 'undefined') localStorage.setItem(RANGE_STORAGE_KEY, value);
  }, []);

  const loadContext = useCallback(async (
    rangeIps: string[],
    alive: Array<{ ip: string; rttMs: number | null }>,
    signal?: AbortSignal
  ) => {
    const next = await api.fetchContext({ rangeIps, alive, includeRouter }, signal);
    if (!mountedRef.current) return null;
    setReport(next);
    return next;
  }, [api, includeRouter]);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    loadContext([], [], controller.signal)
      .catch((err: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setError(err instanceof Error ? err.message : 'Falha ao ler o estado da rede');
      })
      .finally(() => {
        if (mountedRef.current && !controller.signal.aborted) setLoading(false);
      });
  }, [loadContext]);

  // Só à entrada da aba: montar o painel não deve custar um pedido a quem está
  // a olhar para o mapa ao lado.
  useEffect(() => {
    if (active && report === null && !loading) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    abortRef.current?.abort();
  }, []);

  const scan = useCallback(() => {
    let ips: string[];
    try {
      ips = expandRange(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Intervalo inválido');
      return;
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    stoppedRef.current = false;

    setError(null);
    setScanning(true);
    setProgress({ done: 0, total: ips.length });

    void (async () => {
      const alive: Array<{ ip: string; rttMs: number | null }> = [];
      const batches = chunk(ips, SWEEP_BATCH_SIZE);
      try {
        for (const [index, batch] of batches.entries()) {
          if (stoppedRef.current || controller.signal.aborted) break;
          const { results } = await api.sweepBatch(batch, range, index, controller.signal);
          for (const row of results) if (row.ok) alive.push({ ip: row.ip, rttMs: row.rttMs });
          if (!mountedRef.current) return;
          setProgress({ done: Math.min((index + 1) * SWEEP_BATCH_SIZE, ips.length), total: ips.length });
        }

        // Parar não deita fora o que já se descobriu — o cruzamento corre com
        // os endereços que deram tempo de responder.
        if (mountedRef.current) {
          await loadContext(stoppedRef.current ? alive.map((a) => a.ip) : ips, alive);
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Falha ao varrer a rede');
        }
      } finally {
        if (mountedRef.current) {
          setScanning(false);
          setProgress(null);
        }
      }
    })();
  }, [api, loadContext, range]);

  // O intervalo sugerido nasce dos equipamentos já registados — reutiliza o
  // `suggestIpPrefix` que os formulários de equipamento já usam.
  useEffect(() => {
    if (range || !report) return;
    setRangeState(`${suggestIpPrefix(report.registeredIps)}1-254`);
  }, [range, report]);

  return useMemo(() => ({
    range,
    setRange,
    includeRouter,
    setIncludeRouter,
    report,
    loading,
    scanning,
    progress,
    error,
    scan,
    stop,
    refresh
  }), [range, setRange, includeRouter, report, loading, scanning, progress, error, scan, stop, refresh]);
}
