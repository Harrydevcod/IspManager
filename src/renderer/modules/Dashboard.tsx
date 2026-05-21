import { Activity, AlertTriangle, CalendarClock, MessageCircle, PhoneOff, TrendingUp, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Card, Message, MetricCard, MetricGrid } from '../components';
import { authFetch } from '../lib/auth';
import type { DashboardSummary, RevenuePoint } from '../types';

const monthLabelFormatter = new Intl.DateTimeFormat('pt-PT', { month: 'short' });
const currencyFormatter = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 });
const dayMonthFormatter = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: 'short' });

function formatMonthLabel(referenceMonth: string): string {
  const [year, month] = referenceMonth.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return monthLabelFormatter.format(date).replace('.', '');
}

function formatDayMonth(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dayMonthFormatter.format(date).replace('.', '');
}

function formatCve(value: number): string {
  return currencyFormatter.format(value);
}

function formatCompactCve(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}k`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function RevenueBars({ points }: { points: RevenuePoint[] }) {
  const layout = useMemo(() => {
    const width = 560;
    const height = 144;
    const padding = { top: 18, right: 4, bottom: 28, left: 4 };
    const usableW = width - padding.left - padding.right;
    const usableH = height - padding.top - padding.bottom;
    const maxValue = Math.max(1, ...points.map((p) => p.paidCve + p.pendingCve));
    const slot = points.length > 0 ? usableW / points.length : 0;
    const barWidth = Math.min(32, Math.max(8, slot * 0.62));
    const bars = points.map((point, idx) => {
      const total = point.paidCve + point.pendingCve;
      const paidH = (point.paidCve / maxValue) * usableH;
      const pendingH = (point.pendingCve / maxValue) * usableH;
      const cx = padding.left + slot * idx + slot / 2;
      const x = cx - barWidth / 2;
      const paidY = padding.top + usableH - paidH;
      const pendingY = paidY - pendingH;
      const topY = pendingH > 0 ? pendingY : paidY;
      return {
        x,
        cx,
        paidY,
        paidH,
        pendingY,
        pendingH,
        topY,
        barWidth,
        total,
        referenceMonth: point.referenceMonth,
        key: point.referenceMonth
      };
    });
    return { width, height, padding, bars, maxValue, usableH };
  }, [points]);

  if (points.every((p) => p.paidCve === 0 && p.pendingCve === 0)) {
    return <div className="sparkline-empty">Sem registos de receita nos ultimos 12 meses.</div>;
  }

  const baselineY = layout.padding.top + layout.usableH;
  const currentIdx = points.length - 1;
  const labelY = baselineY + 16;

  return (
    <div className="sparkline">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Receita dos ultimos 12 meses"
      >
        <line
          x1={layout.padding.left}
          x2={layout.width - layout.padding.right}
          y1={baselineY}
          y2={baselineY}
          stroke="var(--border)"
          strokeWidth="1"
        />
        {layout.bars.map((bar, idx) => {
          const isCurrent = idx === currentIdx;
          const totalH = bar.paidH + bar.pendingH;
          const valueInside = totalH >= 22 && bar.total > 0;
          const valueY = valueInside ? bar.topY + 12 : bar.topY - 5;
          const showValue = bar.total > 0 && (idx % 2 === 0 || isCurrent);
          return (
            <g key={bar.key} className={isCurrent ? 'bar bar-current' : 'bar'}>
              {bar.pendingH > 0 && (
                <rect
                  x={bar.x}
                  y={bar.pendingY}
                  width={bar.barWidth}
                  height={Math.max(1, bar.pendingH)}
                  rx="1.5"
                  fill="var(--info)"
                  fillOpacity={isCurrent ? '0.45' : '0.28'}
                />
              )}
              {bar.paidH > 0 && (
                <rect
                  x={bar.x}
                  y={bar.paidY}
                  width={bar.barWidth}
                  height={Math.max(1, bar.paidH)}
                  rx="1.5"
                  fill="var(--accent)"
                  fillOpacity={isCurrent ? '1' : '0.78'}
                />
              )}
              {showValue && (
                <text
                  x={bar.cx}
                  y={valueY}
                  textAnchor="middle"
                  className={valueInside ? 'bar-value bar-value-inside' : 'bar-value bar-value-above'}
                >
                  {formatCompactCve(bar.total)}
                </text>
              )}
              <text
                x={bar.cx}
                y={labelY}
                textAnchor="middle"
                className={isCurrent ? 'bar-axis bar-axis-current' : 'bar-axis'}
              >
                {formatMonthLabel(bar.referenceMonth)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const planTypeLabel: Record<string, string> = {
  fibra: 'Fibra',
  radio: 'Radio',
  cabo: 'Cabo',
  outro: 'Outro'
};

export function Dashboard({ onOpenClients }: { onOpenClients: () => void }) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/dashboard/summary')
      .then((response) => {
        if (!response.ok) throw new Error('Nao foi possivel carregar o dashboard');
        return response.json() as Promise<DashboardSummary>;
      })
      .then((data) => {
        setSummary(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Erro ao carregar dashboard');
      });
  }, []);

  const totalPlanCount = summary?.planMix.reduce((acc, entry) => acc + entry.count, 0) || 0;
  const currentMonthRevenue = summary?.revenueByMonth.at(-1)?.paidCve || 0;
  const previousMonthRevenue = summary?.revenueByMonth.at(-2)?.paidCve || 0;
  const revenueTrendPct = previousMonthRevenue > 0
    ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100
    : null;

  const metrics = [
    {
      label: 'Clientes ativos',
      value: summary ? String(summary.activeClients) : '...',
      trend: summary ? `${summary.totalClients} no total` : 'a carregar',
      icon: UsersRound
    },
    {
      label: 'Receita do mes',
      value: summary ? `${formatCve(summary.paidMonthCve)} CVE` : '...',
      trend: revenueTrendPct === null
        ? 'sem comparacao'
        : `${revenueTrendPct >= 0 ? '+' : ''}${revenueTrendPct.toFixed(1)}% vs mes anterior`,
      icon: TrendingUp
    },
    {
      label: 'Em atraso',
      value: summary ? String(summary.overduePayments) : '...',
      trend: summary && summary.pendingPayments > 0 ? `${summary.pendingPayments} pendentes` : 'sem pendentes',
      icon: AlertTriangle
    },
    {
      label: 'Servicos ativos',
      value: summary ? String(summary.activeServices) : '...',
      trend: 'a faturar',
      icon: Activity
    },
    {
      label: 'Sem telefone',
      value: summary ? String(summary.clientsWithoutPhone) : '...',
      trend: 'cadastro incompleto',
      icon: PhoneOff
    }
  ];

  return (
    <>
      {error && <Message tone="error">{error}</Message>}

      <MetricGrid label="Indicadores">
        {metrics.map((metric) => (
          <MetricCard
            key={metric.label}
            icon={metric.icon}
            label={metric.label}
            value={metric.value}
            trend={metric.trend}
          />
        ))}
      </MetricGrid>

      <section className="dashboard-grid">
        <Card eyebrow="Receita" title="12 meses" className="dashboard-card-wide">
          {summary
            ? <RevenueBars points={summary.revenueByMonth} />
            : <p className="module-message">A carregar...</p>}
          <div className="sparkline-legend">
            <span className="legend-item legend-paid">Pago</span>
            <span className="legend-item legend-pending">Pendente</span>
          </div>
        </Card>

        <Card eyebrow="Mix" title="Planos ativos">
          {summary && summary.planMix.length > 0 ? (
            <ul className="plan-mix">
              {summary.planMix.map((entry) => {
                const pct = totalPlanCount > 0 ? (entry.count / totalPlanCount) * 100 : 0;
                return (
                  <li key={entry.connectionType}>
                    <div className="plan-mix-row">
                      <span>{planTypeLabel[entry.connectionType] || entry.connectionType}</span>
                      <strong>{entry.count}</strong>
                    </div>
                    <div className="plan-mix-bar"><span style={{ width: `${pct}%` }} /></div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="module-message">Sem servicos ativos com plano atribuido.</p>
          )}
        </Card>

        <Card eyebrow="Proximos 7 dias" title="Vencimentos" className="dashboard-card-list">
          {summary && summary.upcomingDues.length > 0 ? (
            <ul className="dashboard-list">
              {summary.upcomingDues.map((due) => (
                <li key={due.paymentId}>
                  <CalendarClock size={14} />
                  <div className="dashboard-list-meta">
                    <strong>{due.clientName}</strong>
                    <small>{due.clientCode} - {formatDayMonth(due.dueDate)}</small>
                  </div>
                  <span className="dashboard-list-amount">{formatCve(due.amountCve)} CVE</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="module-message">Nenhum vencimento previsto nos proximos 7 dias.</p>
          )}
        </Card>

        <Card eyebrow="Mais de 30 dias" title="Atrasos criticos" className="dashboard-card-list">
          {summary && summary.criticalOverdue.length > 0 ? (
            <ul className="dashboard-list">
              {summary.criticalOverdue.map((overdue) => (
                <li key={overdue.paymentId}>
                  <AlertTriangle size={14} />
                  <div className="dashboard-list-meta">
                    <strong>{overdue.clientName}</strong>
                    <small>
                      {overdue.clientCode}
                      {overdue.clientPhone ? ` - ${overdue.clientPhone}` : ''}
                    </small>
                  </div>
                  <Badge tone="danger">{overdue.daysOverdue}d</Badge>
                  <span className="dashboard-list-amount">{formatCve(overdue.amountCve)} CVE</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="module-message">Sem atrasos com mais de 30 dias.</p>
          )}
        </Card>

        <Card eyebrow="Hoje" title="Fila de trabalho" className="dashboard-card-wide">
          {summary?.workQueue.length ? (
            <ul className="dashboard-list dashboard-list-queue">
              {summary.workQueue.map((task) => (
                <li key={task}>
                  <MessageCircle size={14} />
                  <div className="dashboard-list-meta">
                    <strong>{task}</strong>
                  </div>
                  <Badge tone="info">Pendente</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="module-message">
              Tudo em dia. Sem pendencias para hoje.
            </p>
          )}
          <div className="dashboard-card-footer">
            <button type="button" className="dashboard-cta" onClick={onOpenClients}>
              <UsersRound size={14} /> Abrir clientes
            </button>
          </div>
        </Card>
      </section>
    </>
  );
}
