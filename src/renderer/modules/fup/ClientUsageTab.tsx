import { useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, ErrorRetry, Select, Skeleton, TabList } from '../../components';
import { apiUrl } from '../../lib/api';
import { authFetch } from '../../lib/auth';
import { formatPtDate } from '../../lib/format';
import { businessDay } from '../../../shared/business-day';
import { formatGb } from './fup-api';
import { UsageBars, type UsageBar } from './UsageBars';
import { dailyAverage, groupByMonth, groupByYear, usageFigures, type UsageDay, type UsagePeriod } from './usage-profile';

export type UsageCycle = {
  start: string; end: string; period: string; current: boolean;
  downBytes: number; upBytes: number; days: number; percent: number;
  fup: 'AVISO' | 'LIMITADO' | null;
};
type UsageClass = 'LEVE' | 'MEDIO' | 'INTENSO' | 'MUITO_INTENSO' | 'SEM_DADOS';
type Profile = { avgDailyBytes: number | null; percentile: number | null; klass: UsageClass; peers: number; overPlafond: boolean };
type UsageData = { referenceGb: number; bytesPerGb: number; cycles: UsageCycle[]; daily: UsageDay[]; profile: Profile | null };
type View = 'cycle' | 'month' | 'year';

const VIEWS = [{ id: 'cycle', label: 'Por ciclo' }, { id: 'month', label: 'Por mês' }, { id: 'year', label: 'Por ano' }] as const;
const CLASS_LABEL: Record<UsageClass, string> = { LEVE: 'Leve', MEDIO: 'Médio', INTENSO: 'Intenso', MUITO_INTENSO: 'Muito intenso', SEM_DADOS: 'Sem dados suficientes' };
const CLASS_TONE: Record<UsageClass, 'neutral' | 'info' | 'accent' | 'warn'> = { LEVE: 'neutral', MEDIO: 'info', INTENSO: 'accent', MUITO_INTENSO: 'warn', SEM_DADOS: 'neutral' };
const monthLong = new Intl.DateTimeFormat('pt-PT', { month: 'long', year: 'numeric' });
const monthShort = new Intl.DateTimeFormat('pt-PT', { month: 'short' });
const asDate = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);

/** "01-11 – 30-11-2026": o ano só uma vez, a não ser que o ciclo passe a passagem de ano. */
export function cycleLabel(start: string, end: string): string {
  const dm = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}`;
  return start.slice(0, 4) === end.slice(0, 4) ? `${dm(start)} – ${formatPtDate(end)}` : `${formatPtDate(start)} – ${formatPtDate(end)}`;
}

type Row = { key: string; label: string; short: string; downBytes: number; upBytes: number; days: number; current: boolean; cycle?: UsageCycle };

function rowsFor(view: View, data: UsageData): Row[] {
  if (view === 'cycle') {
    return data.cycles.map((c) => ({ key: c.start, label: cycleLabel(c.start, c.end), short: monthShort.format(asDate(c.start)).replace('.', ''), downBytes: c.downBytes, upBytes: c.upBytes, days: c.days, current: c.current, cycle: c }));
  }
  const today = businessDay();
  const periods: UsagePeriod[] = view === 'month' ? groupByMonth(data.daily) : groupByYear(data.daily);
  return periods.map((p) => ({
    key: p.key,
    label: view === 'month' ? monthLong.format(asDate(p.key)) : p.key,
    short: view === 'month' ? monthShort.format(asDate(p.key)).replace('.', '') : p.key,
    downBytes: p.downBytes, upBytes: p.upBytes, days: p.days,
    current: today.startsWith(p.key)
  }));
}

/** Aba "Consumo" da ficha do cliente: histórico por ciclo, mês ou ano, e o perfil do cliente. */
export function ClientUsageTab({ services }: { services: Array<{ serviceId: number; label: string }> }) {
  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? 0);
  const [view, setView] = useState<View>('cycle');
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!services.some((s) => s.serviceId === serviceId)) setServiceId(services[0]?.serviceId ?? 0);
  }, [services, serviceId]);

  useEffect(() => {
    if (!serviceId) return;
    let alive = true;
    setData(null);
    setError(false);
    authFetch(apiUrl(`/api/services/${serviceId}/usage-cycles`))
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body = await response.json() as UsageData;
        if (alive) setData(body);
      })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [serviceId, attempt]);

  const rows = useMemo(() => (data ? rowsFor(view, data) : []), [data, view]);
  const figures = useMemo(() => {
    if (!data) return null;
    const completed = data.cycles.filter((c) => !c.current).map((c) => c.downBytes + c.upBytes);
    return usageFigures(data.daily, completed, businessDay());
  }, [data]);
  const perGb = data?.bytesPerGb ?? 1e9;
  const gb = (bytes: number) => formatGb(bytes, perGb);
  const withFup = view === 'cycle' && (data?.referenceGb ?? 0) > 0;
  const bars: UsageBar[] = rows.slice(0, 24).reverse().map((r) => ({ key: r.key, label: r.short, title: r.label, downBytes: r.downBytes, upBytes: r.upBytes, current: r.current }));

  return (
    <div className="client-usage-tab">
      <div className="client-usage-controls">
        {services.length > 1 && (
          <Select label="Serviço" value={String(serviceId)} onChange={(event) => setServiceId(Number(event.target.value))}>
            {services.map((s) => <option key={s.serviceId} value={s.serviceId}>{s.label}</option>)}
          </Select>
        )}
        <TabList idPrefix="client-usage-view" label="Agrupar o consumo" tabs={VIEWS} value={view} onChange={setView} segmented />
      </div>

      {error ? <ErrorRetry message="Não foi possível ler o consumo." onRetry={() => setAttempt((n) => n + 1)} />
        : !data || !figures ? <Skeleton height={240} />
          : data.cycles.length === 0 ? <EmptyState title="Sem consumo medido" size="sm" />
            : (
              <div id={`client-usage-view-panel-${view}`} role="tabpanel" aria-labelledby={`client-usage-view-tab-${view}`} className="client-usage-body">
                <dl className="client-usage-profile">
                  <div>
                    <dt>Perfil</dt>
                    <dd>
                      {data.profile && <Badge tone={CLASS_TONE[data.profile.klass]}>{CLASS_LABEL[data.profile.klass]}</Badge>}
                      {data.profile?.percentile !== null && data.profile?.percentile !== undefined && (
                        <small title={`Comparado com ${data.profile.peers} serviços, média diária dos últimos 90 dias`}>P{data.profile.percentile}</small>
                      )}
                      {data.profile?.overPlafond && <Badge tone="danger">Acima do plafond</Badge>}
                    </dd>
                  </div>
                  <div><dt>Média diária</dt><dd>{gb(figures.avgDaily)}</dd></div>
                  <div><dt>Dias úteis · fim de semana</dt><dd>{figures.weekdayAvg === null ? '—' : gb(figures.weekdayAvg)} · {figures.weekendAvg === null ? '—' : gb(figures.weekendAvg)}</dd></div>
                  <div><dt>Dia de maior consumo</dt><dd>{figures.peak ? <>{gb(figures.peak.bytes)} <small>{formatPtDate(figures.peak.day)}</small></> : '—'}</dd></div>
                  <div>
                    <dt>Tendência</dt>
                    <dd>{figures.trendPercent === null ? '—' : `${figures.trendPercent > 0 ? '↑' : figures.trendPercent < 0 ? '↓' : '→'} ${Math.abs(figures.trendPercent)}%`}</dd>
                  </div>
                </dl>

                <UsageBars bars={bars} perGb={perGb} plafondBytes={withFup ? data.referenceGb * perGb : undefined} />

                <div className="usage-history-scroll">
                  <table className="usage-history-table">
                    <thead>
                      <tr>
                        <th scope="col">{view === 'cycle' ? 'Ciclo' : view === 'month' ? 'Mês' : 'Ano'}</th>
                        <th scope="col">Download</th>
                        <th scope="col">Upload</th>
                        <th scope="col">Total</th>
                        <th scope="col">Média diária</th>
                        {withFup && <th scope="col">% do plafond</th>}
                        {withFup && <th scope="col">Uso justo</th>}
                        <th scope="col">Dias medidos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} aria-current={r.current ? 'true' : undefined}>
                          <th scope="row">{r.label}{r.current && <> <Badge tone="info">Atual</Badge></>}</th>
                          <td>{gb(r.downBytes)}</td>
                          <td>{gb(r.upBytes)}</td>
                          <td><strong>{gb(r.downBytes + r.upBytes)}</strong></td>
                          <td>{gb(dailyAverage(r))}</td>
                          {withFup && <td>{Math.round(r.cycle?.percent ?? 0)}%</td>}
                          {withFup && <td>{r.cycle?.fup === 'LIMITADO' ? <Badge tone="danger">Limitado</Badge> : r.cycle?.fup === 'AVISO' ? <Badge tone="warn">Avisado</Badge> : '—'}</td>}
                          <td>{r.days}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
    </div>
  );
}
