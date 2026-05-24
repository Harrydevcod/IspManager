import { Activity, AlertTriangle, CalendarClock, MessageCircle, TrendingUp, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Badge, Button, Card, Message, MetricCard, MetricGrid } from '../components';
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

const longMonthFormatter = new Intl.DateTimeFormat('pt-PT', { month: 'long', year: 'numeric' });

function formatLongMonth(referenceMonth: string): string {
  const [year, month] = referenceMonth.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return longMonthFormatter.format(date);
}

function RevenueBars({ points }: { points: RevenuePoint[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const layout = useMemo(() => {
    const width = 560;
    const height = 156;
    const padding = { top: 22, right: 4, bottom: 32, left: 4 };
    const usableW = width - padding.left - padding.right;
    const usableH = height - padding.top - padding.bottom;
    const maxValue = Math.max(1, ...points.map((p) => Math.max(p.paidCve + p.pendingCve, p.expenseCve, p.opexCve)));
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
    const paidValues = points.map((p) => p.paidCve).filter((v) => v > 0);
    const avgPaid = paidValues.length > 0 ? paidValues.reduce((a, b) => a + b, 0) / paidValues.length : 0;
    const yearBreaks: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const prevYear = points[i - 1].referenceMonth.slice(0, 4);
      const curYear = points[i].referenceMonth.slice(0, 4);
      if (prevYear !== curYear) yearBreaks.push(i);
    }
    const investments = points.map((p, idx) => {
      const hasData = p.expenseCve > 0;
      const y = padding.top + usableH - (p.expenseCve / maxValue) * usableH;
      return { idx, expenseCve: p.expenseCve, hasData, y, cx: bars[idx].cx };
    });
    const opex = points.map((p, idx) => {
      const hasData = p.opexCve > 0;
      const y = padding.top + usableH - (p.opexCve / maxValue) * usableH;
      return { idx, opexCve: p.opexCve, hasData, y, cx: bars[idx].cx };
    });
    return { width, height, padding, bars, maxValue, usableH, slot, avgPaid, yearBreaks, investments, opex };
  }, [points]);

  const todayKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  if (points.every((p) => p.paidCve === 0 && p.pendingCve === 0 && p.expenseCve === 0 && p.opexCve === 0)) {
    const year = points[0]?.referenceMonth.slice(0, 4) ?? new Date().getFullYear();
    return <div className="sparkline-empty">Sem registos de receita em {year}.</div>;
  }

  const baselineY = layout.padding.top + layout.usableH;
  const currentIdx = points.findIndex((p) => p.referenceMonth === todayKey);
  const labelY = baselineY + 16;
  const avgY = baselineY - (layout.avgPaid / layout.maxValue) * layout.usableH;
  const hovered = hoveredIdx !== null ? layout.bars[hoveredIdx] : null;
  const hoveredPoint = hoveredIdx !== null ? points[hoveredIdx] : null;
  const prevPoint = hoveredIdx !== null && hoveredIdx > 0 ? points[hoveredIdx - 1] : null;
  const deltaPct = hoveredPoint && prevPoint && prevPoint.paidCve > 0
    ? ((hoveredPoint.paidCve - prevPoint.paidCve) / prevPoint.paidCve) * 100
    : null;

  return (
    <div className="sparkline">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Receita dos ultimos 12 meses"
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <line
          x1={layout.padding.left}
          x2={layout.width - layout.padding.right}
          y1={baselineY}
          y2={baselineY}
          stroke="var(--border)"
          strokeWidth="1"
        />

        {layout.yearBreaks.map((breakIdx) => {
          const x = layout.padding.left + layout.slot * breakIdx;
          return (
            <line
              key={`year-${breakIdx}`}
              x1={x}
              x2={x}
              y1={layout.padding.top}
              y2={baselineY}
              stroke="var(--text-3)"
              strokeOpacity="0.18"
              strokeDasharray="2 3"
            />
          );
        })}

        {layout.avgPaid > 0 && (
          <>
            <line
              x1={layout.padding.left}
              x2={layout.width - layout.padding.right}
              y1={avgY}
              y2={avgY}
              stroke="var(--text-3)"
              strokeOpacity="0.55"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text
              x={layout.width - layout.padding.right}
              y={avgY - 4}
              textAnchor="end"
              className="bar-axis bar-axis-meta"
            >
              média {formatCompactCve(layout.avgPaid)}
            </text>
          </>
        )}

        {(() => {
          const linePoints = layout.investments.filter((p) => p.hasData);
          if (linePoints.length < 2) return null;
          const d = linePoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          return (
            <path
              d={d}
              className="expense-line"
              fill="none"
              stroke="var(--danger)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })()}

        {layout.investments.map((p) => {
          if (!p.hasData) return null;
          return (
            <circle
              key={`expense-${p.idx}`}
              cx={p.cx}
              cy={p.y}
              r={p.idx === hoveredIdx ? 4 : 2.5}
              fill="var(--danger)"
              className="expense-dot"
            />
          );
        })}

        {(() => {
          const linePoints = layout.opex.filter((p) => p.hasData);
          if (linePoints.length < 2) return null;
          const d = linePoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          return (
            <path
              d={d}
              className="opex-line"
              fill="none"
              stroke="var(--accent-2)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })()}

        {layout.opex.map((p) => {
          if (!p.hasData) return null;
          return (
            <circle
              key={`opex-${p.idx}`}
              cx={p.cx}
              cy={p.y}
              r={p.idx === hoveredIdx ? 3.5 : 2}
              fill="var(--accent-2)"
              className="opex-dot"
            />
          );
        })}

        {layout.bars.map((bar, idx) => {
          const isCurrent = idx === currentIdx;
          const isHovered = idx === hoveredIdx;
          const dim = hoveredIdx !== null && !isHovered;
          const totalH = bar.paidH + bar.pendingH;
          const valueInside = totalH >= 22 && bar.total > 0;
          const valueY = valueInside ? bar.topY + 12 : bar.topY - 5;
          const showValue = bar.total > 0 && (idx % 2 === 0 || isCurrent);
          let groupClass = 'bar';
          if (isCurrent) groupClass += ' bar-current';
          if (isHovered) groupClass += ' bar-hovered';
          if (dim) groupClass += ' bar-dim';
          return (
            <g
              key={bar.key}
              className={groupClass}
              style={{ ['--i' as never]: idx } as CSSProperties}
              onMouseEnter={() => setHoveredIdx(idx)}
            >
              <rect
                className="bar-hitbox"
                x={layout.padding.left + layout.slot * idx}
                y={layout.padding.top}
                width={layout.slot}
                height={layout.usableH}
                fill="transparent"
              />
              {bar.pendingH > 0 && (
                <rect
                  x={bar.x}
                  y={bar.pendingY}
                  width={bar.barWidth}
                  height={Math.max(1, bar.pendingH)}
                  rx="1.5"
                  fill="var(--info)"
                  fillOpacity={isCurrent || isHovered ? '0.55' : '0.28'}
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
                  fillOpacity={isCurrent || isHovered ? '1' : '0.78'}
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
                className={
                  isCurrent
                    ? 'bar-axis bar-axis-current'
                    : bar.referenceMonth > todayKey
                      ? 'bar-axis bar-axis-future'
                      : 'bar-axis'
                }
              >
                {formatMonthLabel(bar.referenceMonth)}
              </text>
            </g>
          );
        })}
      </svg>

      {hovered && hoveredPoint && (
        <div
          className="bar-tooltip"
          style={{
            left: `${(hovered.cx / layout.width) * 100}%`,
            top: `${(hovered.topY / layout.height) * 100}%`
          }}
          role="status"
          aria-live="polite"
        >
          <p className="bar-tooltip-month">{formatLongMonth(hoveredPoint.referenceMonth)}</p>
          <dl className="bar-tooltip-rows">
            <div>
              <dt><span className="dot dot-paid" />Pago</dt>
              <dd>{formatCompactCve(hoveredPoint.paidCve)} CVE</dd>
            </div>
            <div>
              <dt><span className="dot dot-pending" />Pendente</dt>
              <dd>{formatCompactCve(hoveredPoint.pendingCve)} CVE</dd>
            </div>
            <div>
              <dt><span className="dot dot-expense" />Investimentos</dt>
              <dd>{formatCompactCve(hoveredPoint.expenseCve)} CVE</dd>
            </div>
            <div>
              <dt><span className="dot dot-opex" />Despesas</dt>
              <dd>{formatCompactCve(hoveredPoint.opexCve)} CVE</dd>
            </div>
            {(() => {
              const net = hoveredPoint.paidCve - hoveredPoint.expenseCve - hoveredPoint.opexCve;
              return (
                <div className={`bar-tooltip-total ${net < 0 ? 'profit-negative' : 'profit-positive'}`}>
                  <dt>Lucro</dt>
                  <dd>{net < 0 ? '-' : ''}{formatCompactCve(Math.abs(net))} CVE</dd>
                </div>
              );
            })()}
          </dl>
          {deltaPct !== null && (
            <p className={`bar-tooltip-delta ${deltaPct >= 0 ? 'positive' : 'negative'}`}>
              {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}% vs mes anterior
            </p>
          )}
        </div>
      )}
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
  const currentMonthKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  const currentMonthIndex = summary?.revenueByMonth.findIndex((point) => point.referenceMonth === currentMonthKey) ?? -1;
  const currentMonthRevenue = currentMonthIndex >= 0 ? summary?.revenueByMonth[currentMonthIndex]?.paidCve || 0 : 0;
  const previousMonthRevenue = currentMonthIndex > 0 ? summary?.revenueByMonth[currentMonthIndex - 1]?.paidCve || 0 : 0;
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
        <Card
          eyebrow="Receita anual"
          title={String(new Date().getFullYear())}
          className="dashboard-card-wide"
        >
          {summary
            ? <RevenueBars points={summary.revenueByMonth} />
            : <p className="module-message">A carregar...</p>}
          <div className="sparkline-legend">
            <span className="legend-item legend-paid">Receita paga</span>
            <span className="legend-item legend-pending">Pendente</span>
            <span className="legend-item legend-expense">Investimentos</span>
          </div>
        </Card>

        <Card eyebrow="Proximos 7 dias" title="Vencimentos" className="dashboard-card-list">
          {summary && summary.upcomingDues.length > 0 ? (
            <ul className="dashboard-list">
              {summary.upcomingDues.map((due) => (
                <li key={due.paymentId}>
                  <CalendarClock size={14} />
                  <div className="dashboard-list-meta">
                    <small className="entity-code">{due.clientCode}</small>
                    <strong>{due.clientName}</strong>
                    <small>{formatDayMonth(due.dueDate)}</small>
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
                    <small className="entity-code">{overdue.clientCode}</small>
                    <strong>{overdue.clientName}</strong>
                    {overdue.clientPhone && <small>{overdue.clientPhone}</small>}
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

        <Card eyebrow="Mix" title="Planos ativos" className="dashboard-card-compact">
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
            <Button variant="secondary" className="dashboard-cta" leadingIcon={<UsersRound size={14} aria-hidden />} onClick={onOpenClients}>
              Abrir clientes
            </Button>
          </div>
        </Card>
      </section>
    </>
  );
}
