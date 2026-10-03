import { ChartColumn } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatDataVolume, ROUTER_API, type RouterWanUsage } from './router-api';

const dateLabel = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
const shortDate = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}`;
// A Starlink cobra o total (↓+↑): as barras mostram o mesmo número que a conta.
const volume = (row: { rxBytes: number; txBytes: number }) => row.rxBytes + row.txBytes;
// Rótulo curto em cada barra (a unidade está na legenda): cabe numa coluna de 30 dias.
const gigabytes = (bytes: number) => new Intl.NumberFormat('pt-PT', { maximumFractionDigits: bytes < 10e9 ? 1 : 0 }).format(bytes / 1e9);

function History({ data }: { data: RouterWanUsage }) {
  const names = [...new Set(data.days.flatMap((day) => day.perInterface.map((row) => row.interface)))].sort();
  const dayTotal = (day: RouterWanUsage['days'][number]) => day.perInterface.reduce((total, row) => total + volume(row), 0);
  // Antes de o router contar, a app fechada empurrava o tráfego para o dia da reabertura: picos
  // falsos que não podem ditar a escala.
  // Um dia copiado da conta Starlink já é a verdade e conta como exato.
  const estimated = (day: RouterWanUsage['days'][number]) => (!data.exactSince || day.day < data.exactSince) &&
    day.perInterface.some((row) => row.source !== 'starlink' && volume(row) > 0);
  const scaled = data.days.some((day) => !estimated(day)) ? data.days.filter((day) => !estimated(day)) : data.days;
  const max = Math.max(1, ...scaled.map(dayTotal));
  const peakIndex = data.days.findIndex((day) => scaled.includes(day) && dayTotal(day) === max);
  return (
    <div className="router-usage-history">
      <div className="router-usage-chart" role="img" aria-label="Consumo diário das WAN nos últimos 30 dias">
        <div className="router-usage-bars" style={{ gridTemplateColumns: `repeat(${data.days.length}, 1fr)` }}>
          {data.days.map((day, index) => {
            const rows = [...day.perInterface].sort((a, b) => a.interface.localeCompare(b.interface));
            const total = rows.reduce((sum, row) => sum + volume(row), 0);
            const isEstimated = total > 0 && estimated(day);
            const tooltip = `${dateLabel(day.day)} · soma das WAN ${formatDataVolume(total)} · ${rows.map((row) => row.source === 'starlink'
              ? `${row.interface}: total ${formatDataVolume(volume(row))} (conta Starlink)`
              : `${row.interface}: ↓ ${formatDataVolume(row.rxBytes)} · ↑ ${formatDataVolume(row.txBytes)} · total ${formatDataVolume(row.rxBytes + row.txBytes)}`).join(' · ')}${isEstimated ? ' · contagem antiga da app, não comparável com a Starlink' : ''}`;
            const labelPosition = index >= data.days.length - 3 ? 'is-end' : index < 3 ? 'is-start' : '';
            return (
              <div key={day.day} className={`router-usage-day${total === 0 ? ' is-empty' : ''}${isEstimated ? ' is-estimated' : ''}`} title={tooltip}>
                {rows.map((row) => <i key={row.interface} className={names.indexOf(row.interface) === 0 ? 'is-first' : 'is-second'} style={{ height: `${volume(row) / Math.max(max, total) * 100}%` }} />)}
                {total > 0 && (
                  <span className={`router-usage-total ${labelPosition}${index === data.days.length - 1 || index === peakIndex ? ' is-key' : ''}`} style={{ bottom: `calc(${Math.min(total, max) / max * 100}% + 4px)` }}>{gigabytes(total)}</span>
                )}
              </div>
            );
          })}
        </div>
        <div className="router-usage-axis" style={{ gridTemplateColumns: `repeat(${data.days.length}, 1fr)` }}>
          {data.days.map((day, index) => index % 5 === 0 && <span key={day.day} style={{ gridColumn: index + 1 }}>{shortDate(day.day)}</span>)}
        </div>
      </div>
      <div className="router-usage-legend">{names.map((name, index) => <span key={name}><i className={index === 0 ? 'is-first' : 'is-second'} />{name}</span>)}<span className="router-muted">número por cima = soma das WAN, em GB</span></div>
    </div>
  );
}

/** O histórico diário; hoje e o mês de cada WAN estão nos cartões ao vivo. */
export function WanUsage({ live }: { live: { data: RouterWanUsage | null; error: string | null; reload: () => void } }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const data = live.data;
  // Só conta como ativo se o último import do ficheiro do router for recente; senão o job voltou ao fallback.
  const counting = !!data?.routerImportedAt && Date.now() - Date.parse(data.routerImportedAt) < 10 * 60_000;
  const since = data?.since;
  const start = since ? new Date(since) : null;
  const startLabel = start && !Number.isNaN(start.getTime())
    ? `${String(start.getDate()).padStart(2, '0')}-${String(start.getMonth() + 1).padStart(2, '0')}-${start.getFullYear()} às ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
    : null;
  const install = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await authFetch(`${ROUTER_API}/wan/usage/counter`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? 'Não foi possível instalar o contador.');
      }
      live.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Não foi possível instalar o contador.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="router-wan router-usage" aria-label="Consumo diário das WAN">
      <div className="router-wan-header">
        <h3><ChartColumn size={16} aria-hidden /> Consumo diário das WAN</h3>
        <div className="router-usage-actions">
          {counting
            ? <span className="router-muted">A contar no router</span>
            : <Button variant="secondary" onClick={install} disabled={busy}>{busy ? 'A instalar…' : 'Contar no router'}</Button>}
          {startLabel && <span className="router-muted router-usage-since">últimos 30 dias · ↓+↑ por dia UTC, como a Starlink · a contar desde {startLabel}</span>}
        </div>
      </div>
      {actionError && <p role="alert" className="router-muted">{actionError}</p>}
      {!data ? <p className="router-muted">{live.error ?? 'A ler os registos…'}</p> : !since ? (
        <p className="router-muted">Ainda sem registos</p>
      ) : (
        <History data={data} />
      )}
    </section>
  );
}
