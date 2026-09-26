import { ArrowDown, ArrowUp, ChartColumn } from 'lucide-react';
import { formatDataVolume, ROUTER_API, type RouterWanUsage, type WanUsageRow } from './router-api';
import { useLive } from './useLive';

const sum = (rows: WanUsageRow[], key: 'rxBytes' | 'txBytes') => rows.reduce((total, row) => total + row[key], 0);
const dateLabel = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
const shortDate = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}`;

function Period({ label, rows }: { label: string; rows: WanUsageRow[] }) {
  return (
    <article className="router-usage-period">
      <h4>{label}</h4>
      <strong className="router-usage-value"><ArrowDown size={18} aria-hidden /> {formatDataVolume(sum(rows, 'rxBytes'))}</strong>
      <p className="router-usage-split">{rows.map((row) => `${row.interface} ${formatDataVolume(row.rxBytes)}`).join(' · ')}</p>
      <p className="router-usage-upload"><ArrowUp size={13} aria-hidden /> Upload {formatDataVolume(sum(rows, 'txBytes'))}</p>
    </article>
  );
}

function History({ data }: { data: RouterWanUsage }) {
  const names = [...new Set(data.days.flatMap((day) => day.perInterface.map((row) => row.interface)))].sort();
  const max = Math.max(1, ...data.days.map((day) => day.perInterface.reduce((total, row) => total + row.rxBytes, 0)));
  const baseline = 105;
  const height = 86;
  return (
    <div className="router-usage-history">
      <h4>Últimos 30 dias</h4>
      <svg viewBox="0 0 600 124" preserveAspectRatio="none" role="img" aria-label="Download diário das WAN nos últimos 30 dias">
        {data.days.map((day, index) => {
          const rows = [...day.perInterface].sort((a, b) => a.interface.localeCompare(b.interface));
          let top = baseline;
          const x = index * 20 + 2;
          return (
            <g key={day.day}>
              <title>{dateLabel(day.day)} · {rows.map((row) => `${row.interface} ${formatDataVolume(row.rxBytes)}`).join(' · ')}</title>
              {rows.map((row, rowIndex) => {
                const barHeight = row.rxBytes / max * height;
                top -= barHeight;
                return <rect key={row.interface} x={x} y={top} width="15" height={barHeight} fill={rowIndex === 0 ? 'var(--accent)' : 'var(--info)'} />;
              })}
              {index % 5 === 0 && <text x={x} y="121">{shortDate(day.day)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="router-usage-legend">{names.map((name, index) => <span key={name}><i className={index === 0 ? 'is-first' : 'is-second'} />{name}</span>)}</div>
    </div>
  );
}

export function WanUsage() {
  const live = useLive<RouterWanUsage>(`${ROUTER_API}/wan/usage`, true, 60_000);
  const data = live.data;
  const since = data?.since;
  const start = since ? new Date(since) : null;
  const startLabel = start && !Number.isNaN(start.getTime())
    ? `${String(start.getDate()).padStart(2, '0')}-${String(start.getMonth() + 1).padStart(2, '0')}-${start.getFullYear()} às ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
    : null;
  return (
    <section className="router-wan router-usage" aria-label="Tráfego acumulado das WAN">
      <div className="router-wan-header"><h3><ChartColumn size={16} aria-hidden /> Tráfego acumulado das WAN</h3></div>
      {!data ? <p className="router-muted">{live.error ?? 'A ler os registos…'}</p> : !since ? (
        <p className="router-muted">Ainda sem registos</p>
      ) : (
        <>
          <p className="router-muted router-usage-since">A contar desde {startLabel}</p>
          <div className="router-usage-grid"><Period label="Hoje" rows={data.today} /><Period label="Este mês" rows={data.month} /></div>
          <History data={data} />
        </>
      )}
    </section>
  );
}
