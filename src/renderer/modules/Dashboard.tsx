import { Activity, AlertTriangle, CalendarClock, MessageCircle, TrendingUp, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Message, MetricCard, MetricGrid, RevenueBars, formatCompactCve } from '../components';
import { authFetch } from '../lib/auth';
import { formatPtDate } from '../lib/format';
import type { DashboardSummary } from '../types';

const currencyFormatter = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 });

function formatCve(value: number): string {
  return currencyFormatter.format(value);
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
  const attentionCount = summary
    ? summary.overduePayments + summary.lowStockModels + summary.openWorkOrders
    : 0;
  const criticalOverdueCve = summary?.criticalOverdue.reduce((acc, overdue) => acc + overdue.amountCve, 0) || 0;
  const briefNeedsAttention = attentionCount > 0;

  const metrics = [
    {
      label: 'Clientes ativos',
      value: summary ? String(summary.activeClients) : '...',
      trend: summary ? `${summary.totalClients} no total` : 'a carregar',
      icon: UsersRound,
      tone: 'success' as const
    },
    {
      label: 'Receita do mes',
      value: summary ? `${formatCve(summary.paidMonthCve)} CVE` : '...',
      trend: revenueTrendPct === null
        ? 'sem comparacao'
        : `${revenueTrendPct >= 0 ? '+' : ''}${revenueTrendPct.toFixed(1)}% vs mes anterior`,
      icon: TrendingUp,
      tone: 'revenue' as const
    },
    {
      label: 'Em atraso',
      value: summary ? String(summary.overduePayments) : '...',
      trend: summary && summary.pendingPayments > 0 ? `${summary.pendingPayments} pendentes` : 'sem pendentes',
      icon: AlertTriangle,
      tone: summary && summary.overduePayments > 0 ? 'danger' as const : 'neutral' as const
    },
    {
      label: 'Servicos ativos',
      value: summary ? String(summary.activeServices) : '...',
      trend: 'a faturar',
      icon: Activity,
      tone: 'info' as const
    }
  ];

  return (
    <>
      {error && <Message tone="error">{error}</Message>}

      <section
        className={`operations-brief${briefNeedsAttention ? ' operations-brief-attention' : ''}`}
        aria-label="Estado operacional"
      >
        <div className="operations-brief-main">
          <p className="eyebrow">Comando operacional</p>
          <p>
            {summary
              ? briefNeedsAttention
                ? `${attentionCount} sinais pedem acao: cobrancas em atraso, stock baixo ou ordens abertas.`
                : 'Sem alertas criticos neste momento. A equipa pode concentrar-se em crescimento e atendimento.'
              : 'A carregar o estado da operacao.'}
          </p>
        </div>
        <dl className="operations-brief-rail">
          <div>
            <dt>Receita mes</dt>
            <dd>{summary ? formatCompactCve(summary.paidMonthCve) : '...'}</dd>
          </div>
          <div>
            <dt>Vencimentos</dt>
            <dd>{summary ? summary.upcomingDues.length : '...'}</dd>
          </div>
          <div>
            <dt>Atraso critico</dt>
            <dd>{summary ? formatCompactCve(criticalOverdueCve) : '...'}</dd>
          </div>
          <div>
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
            : <p className="module-message">A carregar...</p>}
        </Card>

        <Card eyebrow="Distribuicao" title="Planos ativos" className="dashboard-card-distribution">
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
