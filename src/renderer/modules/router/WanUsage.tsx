import { ChartColumn } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatDataVolume, ROUTER_API, type RouterWanUsage } from './router-api';

const dateLabel = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
const shortDate = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}`;

function History({ data }: { data: RouterWanUsage }) {
  const names = [...new Set(data.days.flatMap((day) => day.perInterface.map((row) => row.interface)))].sort();
  const max = Math.max(1, ...data.days.map((day) => day.perInterface.reduce((total, row) => total + row.rxBytes, 0)));
  const peakIndex = data.days.findIndex((day) => day.perInterface.reduce((total, row) => total + row.rxBytes, 0) === max);
  return (
    <div className="router-usage-history">
      <div className="router-usage-chart" role="img" aria-label="Download diário das WAN nos últimos 30 dias">
        <div className="router-usage-bars" style={{ gridTemplateColumns: `repeat(${data.days.length}, 1fr)` }}>
          {data.days.map((day, index) => {
            const rows = [...day.perInterface].sort((a, b) => a.interface.localeCompare(b.interface));
            const total = rows.reduce((sum, row) => sum + row.rxBytes, 0);
            const tooltip = `${dateLabel(day.day)} · ${rows.map((row) => `${row.interface}: ↓ ${formatDataVolume(row.rxBytes)} · ↑ ${formatDataVolume(row.txBytes)} · total ${formatDataVolume(row.rxBytes + row.txBytes)}`).join(' · ')}`;
            const labelPosition = index >= data.days.length - 3 ? 'is-end' : index < 3 ? 'is-start' : '';
            return (
              <div key={day.day} className={`router-usage-day${total === 0 ? ' is-empty' : ''}`} title={tooltip}>
                {rows.map((row) => <i key={row.interface} className={names.indexOf(row.interface) === 0 ? 'is-first' : 'is-second'} style={{ height: `${row.rxBytes / max * 100}%` }} />)}
                {total > 0 && (index === data.days.length - 1 || index === peakIndex) && (
                  <span className={`router-usage-total ${labelPosition}`} style={{ bottom: `calc(${total / max * 100}% + 4px)` }}>{formatDataVolume(total)}</span>
                )}
              </div>
            );
          })}
        </div>
        <div className="router-usage-axis" style={{ gridTemplateColumns: `repeat(${data.days.length}, 1fr)` }}>
          {data.days.map((day, index) => index % 5 === 0 && <span key={day.day} style={{ gridColumn: index + 1 }}>{shortDate(day.day)}</span>)}
        </div>
      </div>
      <div className="router-usage-legend">{names.map((name, index) => <span key={name}><i className={index === 0 ? 'is-first' : 'is-second'} />{name}</span>)}</div>
    </div>
  );
}

/** O histórico diário; hoje e o mês de cada WAN estão nos cartões ao vivo. */
export function WanUsage({ live }: { live: { data: RouterWanUsage | null; error: string | null; reload: () => void } }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const data = live.data;
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
    <section className="router-wan router-usage" aria-label="Download diário das WAN">
      <div className="router-wan-header">
        <h3><ChartColumn size={16} aria-hidden /> Download diário das WAN</h3>
        <div className="router-usage-actions">
          {data?.routerImportedAt
            ? <span className="router-muted">A contar no router</span>
            : <Button variant="secondary" onClick={install} disabled={busy}>{busy ? 'A instalar…' : 'Contar no router'}</Button>}
          {startLabel && <span className="router-muted router-usage-since">últimos 30 dias · a contar desde {startLabel}</span>}
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
