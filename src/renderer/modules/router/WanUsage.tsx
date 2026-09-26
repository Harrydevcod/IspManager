import { ChartColumn } from 'lucide-react';
import { formatDataVolume, type RouterWanUsage } from './router-api';

const dateLabel = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
const shortDate = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}`;

function History({ data }: { data: RouterWanUsage }) {
  const names = [...new Set(data.days.flatMap((day) => day.perInterface.map((row) => row.interface)))].sort();
  const max = Math.max(1, ...data.days.map((day) => day.perInterface.reduce((total, row) => total + row.rxBytes, 0)));
  const baseline = 105;
  const height = 86;
  return (
    <div className="router-usage-history">
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

/** O histórico diário; hoje e o mês de cada WAN estão nos cartões ao vivo. */
export function WanUsage({ live }: { live: { data: RouterWanUsage | null; error: string | null } }) {
  const data = live.data;
  const since = data?.since;
  const start = since ? new Date(since) : null;
  const startLabel = start && !Number.isNaN(start.getTime())
    ? `${String(start.getDate()).padStart(2, '0')}-${String(start.getMonth() + 1).padStart(2, '0')}-${start.getFullYear()} às ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
    : null;
  return (
    <section className="router-wan router-usage" aria-label="Download diário das WAN">
      <div className="router-wan-header">
        <h3><ChartColumn size={16} aria-hidden /> Download diário das WAN</h3>
        {startLabel && <span className="router-muted router-usage-since">últimos 30 dias · a contar desde {startLabel}</span>}
      </div>
      {!data ? <p className="router-muted">{live.error ?? 'A ler os registos…'}</p> : !since ? (
        <p className="router-muted">Ainda sem registos</p>
      ) : (
        <History data={data} />
      )}
    </section>
  );
}
