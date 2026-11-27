import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { Badge, EmptyState, ErrorRetry, Skeleton } from '../../components';
import { apiUrl } from '../../lib/api';
import { authFetch } from '../../lib/auth';
import { formatPtDate } from '../../lib/format';
import { formatGb } from './fup-api';

export type UsageCycle = {
  start: string; end: string; period: string; current: boolean;
  downBytes: number; upBytes: number; days: number; percent: number;
  fup: 'AVISO' | 'LIMITADO' | null;
};
type HistoryData = { referenceGb: number; bytesPerGb: number; cycles: UsageCycle[] };

/** "01-11 – 30-11-2026": o ano só uma vez, a não ser que o ciclo passe a passagem de ano. */
export function cycleLabel(start: string, end: string): string {
  const dm = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}`;
  return start.slice(0, 4) === end.slice(0, 4) ? `${dm(start)} – ${formatPtDate(end)}` : `${formatPtDate(start)} – ${formatPtDate(end)}`;
}

/**
 * Consumo do serviço ciclo a ciclo, do atual para os anteriores.
 * ponytail: tabela nativa sem ordenação; são no máximo 24 linhas já por data.
 */
export function UsageHistory({ serviceId }: { serviceId: number }) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setHistory(null);
    setError(false);
    authFetch(apiUrl(`/api/services/${serviceId}/usage-cycles`))
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json() as HistoryData;
        if (alive) setHistory(data);
      })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [serviceId, attempt]);

  const gb = (bytes: number) => formatGb(bytes, history?.bytesPerGb);
  // Sem plafond, a % não diz nada: a coluna não aparece.
  const withPercent = (history?.referenceGb ?? 0) > 0;

  return (
    <div className="usage-history" aria-busy={!history && !error}>
      <p className="eyebrow"><History size={12} /> Consumo por ciclo</p>
      {error ? <ErrorRetry message="Não foi possível ler o histórico de consumo." onRetry={() => setAttempt((n) => n + 1)} />
        : !history ? <Skeleton height={96} />
          : history.cycles.length === 0 ? <EmptyState title="Sem consumo medido" size="sm" />
            : (
              <div className="usage-history-scroll">
                <table className="usage-history-table">
                  <thead>
                    <tr>
                      <th scope="col">Ciclo</th>
                      <th scope="col">Download</th>
                      <th scope="col">Upload</th>
                      <th scope="col">Total</th>
                      {withPercent && <th scope="col">% do plafond</th>}
                      <th scope="col">Uso justo</th>
                      <th scope="col">Dias medidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.cycles.map((c) => (
                      <tr key={c.start} aria-current={c.current ? 'true' : undefined}>
                        <th scope="row">
                          {cycleLabel(c.start, c.end)}
                          {c.current && <> <Badge tone="info">Atual</Badge></>}
                        </th>
                        <td>{gb(c.downBytes)}</td>
                        <td>{gb(c.upBytes)}</td>
                        <td><strong>{gb(c.downBytes + c.upBytes)}</strong></td>
                        {withPercent && <td>{Math.round(c.percent)}%</td>}
                        <td>{c.fup === 'LIMITADO' ? <Badge tone="danger">Limitado</Badge> : c.fup === 'AVISO' ? <Badge tone="warn">Avisado</Badge> : '—'}</td>
                        <td>{c.days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
    </div>
  );
}
