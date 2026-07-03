import { Activity, AlertTriangle, CalendarClock, MessageCircle, TrendingUp, UsersRound, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { Badge, Button, Card, ErrorRetry, MetricCard, MetricGrid, RevenueBars, Skeleton } from '../components';
import { authFetch } from '../lib/auth';
import { formatCve, formatPtDate } from '../lib/format';
import type { DashboardSummary } from '../types';

type DashboardProps = {
  onOpenClients: () => void;
  onOpenOverdue: () => void;
  onOpenPending: () => void;
  onOpenLowStock: () => void;
  onOpenWorkOrders: () => void;
};

// Torna um tile/elemento informativo acionável por teclado (Enter/Espaço) e rato.
function activatable(onActivate: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    }
  };
}

export function Dashboard({
  onOpenClients,
  onOpenOverdue,
  onOpenPending,
  onOpenLowStock,
  onOpenWorkOrders
}: DashboardProps) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(() => {
    return authFetch('http://127.0.0.1:3001/api/dashboard/summary')
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

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  // Tendência caixa-com-caixa: o tile "Receita do mes" é regime de caixa
  // (recebido no mês), por isso compara com o recebido no mês anterior — a
  // série revenueByMonth é por competência e serve o gráfico, não este tile.
  const previousMonthRevenue = summary?.paidPrevMonthCve || 0;
  const revenueTrendPct = previousMonthRevenue > 0
    ? (((summary?.paidMonthCve || 0) - previousMonthRevenue) / previousMonthRevenue) * 100
    : null;
  const attentionCount = summary
    ? summary.overduePayments + summary.openWorkOrders
    : 0;
  const criticalOverdueCve = summary?.criticalOverdue.reduce((acc, overdue) => acc + overdue.amountCve, 0) || 0;
  const briefNeedsAttention = attentionCount > 0;
  const openPaymentCount = summary ? summary.pendingPayments + summary.overduePayments : 0;
  const alertSignals = summary
    ? [
        { label: 'Atraso', value: summary.overduePayments, tone: 'danger' },
        { label: 'Ordens', value: summary.openWorkOrders, tone: 'info' }
      ].filter((signal) => signal.value > 0)
    : [];

  const metrics = [
    {
      label: 'Clientes ativos',
      value: summary ? String(summary.activeClients) : '...',
      trend: summary ? `${summary.totalClients} no total` : 'a carregar',
      icon: UsersRound,
      tone: 'success' as const,
      onActivate: onOpenClients
    },
    {
      label: 'Receita do mes',
      value: summary ? formatCve(summary.paidMonthCve) : '...',
      trend: revenueTrendPct === null
        ? 'sem comparacao'
        : `${revenueTrendPct >= 0 ? '+' : ''}${revenueTrendPct.toFixed(1)}% vs mes anterior`,
      icon: TrendingUp,
      tone: 'revenue' as const,
      onActivate: undefined as (() => void) | undefined
    },
    {
      label: 'Pendente do mes',
      value: summary ? formatCve(summary.pendingMonthCve) : '...',
      trend: openPaymentCount > 0
        ? `${openPaymentCount} cobrancas por receber`
        : 'sem cobrancas pendentes',
      icon: CalendarClock,
      tone: summary && summary.pendingMonthCve > 0 ? 'warning' as const : 'neutral' as const,
      onActivate: onOpenPending
    },
    {
      label: 'Em atraso',
      value: summary ? String(summary.overduePayments) : '...',
      trend: summary && summary.pendingPayments > 0 ? `${summary.pendingPayments} pendentes` : 'sem pendentes',
      icon: AlertTriangle,
      tone: summary && summary.overduePayments > 0 ? 'danger' as const : 'neutral' as const,
      onActivate: onOpenOverdue
    },
    {
      label: 'Servicos ativos',
      value: summary ? String(summary.activeServices) : '...',
      trend: 'a faturar',
      icon: Activity,
      tone: 'info' as const,
      onActivate: undefined as (() => void) | undefined
    }
  ];

  return (
    <>
      {error && !summary && <ErrorRetry message={error} onRetry={() => { void loadSummary(); }} />}

      <section
        className={`operations-brief${briefNeedsAttention ? ' operations-brief-attention' : ''}`}
        aria-label="Estado operacional"
      >
        <div className="operations-brief-main">
          <p className="eyebrow">Comando operacional</p>
          {summary ? (
            briefNeedsAttention ? (
              <div className="operations-alert-strip" aria-label={`${attentionCount} sinais operacionais`}>
                {alertSignals.map((signal) => (
                  <span className="operations-alert-chip" data-tone={signal.tone} key={signal.label}>
                    <span aria-hidden>!</span>
                    <strong>{signal.value}</strong>
                    {signal.label}
                  </span>
                ))}
              </div>
            ) : (
              <p className="operations-brief-clear">Sem alertas criticos</p>
            )
          ) : (
            <p className="operations-brief-clear">A carregar o estado da operacao.</p>
          )}
        </div>
        <dl className="operations-brief-rail">
          <div>
            <dt>Receita acumulada</dt>
            <dd>{summary ? formatCve(summary.paidTotalCve) : '...'}</dd>
          </div>
          <div className="brief-tile-action" data-alert={summary && summary.pendingPreviousCve > 0 ? 'danger' : undefined} {...(summary ? activatable(onOpenPending) : {})}>
            <dt>Pendente acumulado</dt>
            <dd>{summary ? formatCve(summary.pendingPreviousCve) : '...'}</dd>
          </div>
          <div className="brief-tile-action" {...(summary ? activatable(onOpenPending) : {})}>
            <dt>Vencimentos</dt>
            <dd>{summary ? summary.upcomingDues.length : '...'}</dd>
          </div>
          <div className="brief-tile-action" data-alert={summary && criticalOverdueCve > 0 ? 'danger' : undefined} {...(summary ? activatable(onOpenOverdue) : {})}>
            <dt>Atraso critico</dt>
            <dd>{summary ? formatCve(criticalOverdueCve) : '...'}</dd>
          </div>
          <div className="brief-tile-action" data-alert={summary && summary.lowStockModels > 0 ? 'warning' : undefined} {...(summary ? activatable(onOpenLowStock) : {})}>
            <dt>Stock baixo</dt>
            <dd>{summary ? summary.lowStockModels : '...'}</dd>
          </div>
        </dl>
      </section>

      <section className="dashboard-topline" aria-label="Resumo visual da operacao">
        <Card
          eyebrow="Receita mensal"
          title={String(new Date().getFullYear())}
          className="dashboard-card-chart"
        >
          {summary
            ? <RevenueBars points={summary.revenueByMonth} />
            : <Skeleton height={180} radius={12} />}
        </Card>
      </section>

      <div className="dashboard-section-label">
        <p className="eyebrow">Dados do mes</p>
        <span>Metricas filtradas pelo periodo atual</span>
      </div>

      <MetricGrid label="Indicadores">
        {metrics.map((metric) => (
          <MetricCard
            key={metric.label}
            icon={metric.icon}
            label={metric.label}
            value={metric.value}
            trend={metric.trend}
            tone={metric.tone}
            onActivate={summary ? metric.onActivate : undefined}
          />
        ))}
      </MetricGrid>

      <section className="dashboard-grid">
        <Card eyebrow="Proximos 7 dias" title="Vencimentos" className="dashboard-card-list">
          {summary && summary.upcomingDues.length > 0 ? (
            <ul className="dashboard-list">
              {summary.upcomingDues.map((due) => (
                <li key={due.paymentId}>
                  <CalendarClock size={14} />
                  <div className="dashboard-list-meta">
                    <small className="entity-code">{due.clientCode}</small>
                    <strong>{due.clientName}</strong>
                    <small>{formatPtDate(due.dueDate)}</small>
                  </div>
                  <span className="dashboard-list-amount">{formatCve(due.amountCve)}</span>
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
                  <span className="dashboard-list-amount">{formatCve(overdue.amountCve)}</span>
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
            <Button variant="secondary" className="dashboard-cta" leadingIcon={<Wrench size={14} aria-hidden />} onClick={onOpenWorkOrders}>
              Abrir ordens
            </Button>
            <Button variant="secondary" className="dashboard-cta" leadingIcon={<UsersRound size={14} aria-hidden />} onClick={onOpenClients}>
              Abrir clientes
            </Button>
          </div>
        </Card>
      </section>
    </>
  );
}
