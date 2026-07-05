import { Banknote, Coins, Download, FileText, Percent, RadioTower, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, ErrorRetry, Field, Message, MetricCard, MetricGrid, RevenueBars, formatCompactCve } from '../components';
import { authFetch } from '../lib/auth';
import { downloadAuthenticated } from '../lib/download';
import { formatCve } from '../lib/format';
import './InvestmentsModule.css';
import { EMPTY_INVESTMENT_LIST, type InvestmentList, type RevenuePoint } from '../types';

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Lucro — the analytical half of the finance area: portfolio brief, KPIs, the flagship
 * RevenueBars chart, alerts and the invested-vs-annual-return analysis. Management (list +
 * CRUD) lives in InvestmentsModule. Both read the same /api/investments endpoint independently.
 */
export function ProfitModule() {
  const [exportBusy, setExportBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [data, setData] = useState<InvestmentList>(EMPTY_INVESTMENT_LIST);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [month, setMonth] = useState(currentMonth());
  // Default "Todos os meses": investimentos são esporádicos — o mês corrente
  // aterrava a aba Lucro vazia na maioria dos meses.
  const [showAllMonths, setShowAllMonths] = useState(true);
  const [revenuePoints, setRevenuePoints] = useState<RevenuePoint[]>([]);
  const [activeClients, setActiveClients] = useState(0);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (!showAllMonths) params.set('month', month);
    return authFetch(`http://127.0.0.1:3001/api/investments?${params}`)
      .then((response) => response.json() as Promise<InvestmentList>)
      .then((payload) => { setData(payload); setLoadError(null); })
      .catch(() => { setData(EMPTY_INVESTMENT_LIST); setLoadError('Não foi possível carregar a rentabilidade.'); });
  }, [month, showAllMonths]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/dashboard/summary')
      .then((response) => response.ok ? response.json() as Promise<{ revenueByMonth: RevenuePoint[]; activeClients: number }> : null)
      .then((payload) => {
        setRevenuePoints(payload?.revenueByMonth ?? []);
        setActiveClients(payload?.activeClients ?? 0);
      })
      .catch(() => {
        setRevenuePoints([]);
        setActiveClients(0);
      });
  }, []);

  const downloadReport = useCallback(async (format: 'pdf' | 'xlsx') => {
    setExportBusy(format);
    setExportError(null);
    try {
      const fallback = `Rentabilidade-${new Date().toISOString().slice(0, 10)}.${format}`;
      await downloadAuthenticated(`http://127.0.0.1:3001/api/investments/report.${format}`, fallback);
    } catch {
      setExportError('Não foi possível gerar o relatório. Tenta novamente.');
    } finally {
      setExportBusy(null);
    }
  }, []);

  const investmentReturnRows = useMemo(() => {
    const rows = data.rows
      .map((investment) => ({
        id: investment.id,
        name: investment.name,
        invested: investment.totalCostCve,
        annualReturn: investment.monthlyNetProfitCve * 12,
        roi: investment.annualRoiPct
      }))
      .sort((a, b) => Math.max(b.invested, b.annualReturn) - Math.max(a.invested, a.annualReturn))
      .slice(0, 8);
    const maxValue = Math.max(1, ...rows.flatMap((row) => [row.invested, Math.abs(row.annualReturn)]));
    return rows.map((row) => ({
      ...row,
      investedPct: (row.invested / maxValue) * 100,
      annualReturnPct: (Math.abs(row.annualReturn) / maxValue) * 100
    }));
  }, [data.rows]);

  const notRecovered = data.totals.notRecoveredCount;
  const briefAttention = notRecovered > 0;
  const briefSentence = data.totals.count === 0
    ? 'Sem investimentos no período selecionado.'
    : briefAttention
      ? `${notRecovered} ${notRecovered === 1 ? 'investimento ainda não recuperou' : 'investimentos ainda não recuperaram'} o capital aplicado. Acompanha o lucro mensal para encurtar o payback.`
      : 'Todos os investimentos no filtro já recuperaram o capital. O portfólio está a gerar retorno líquido.';

  return (
    <section className="module-panel investments-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Painel financeiro ISP</p>
          <h2>Lucro</h2>
        </div>
        <div className="inline-actions">
          <Field label="Mes" type="month" value={month} onChange={(e) => setMonth(e.target.value)} disabled={showAllMonths} />
          <Button variant="secondary" onClick={() => setShowAllMonths((s) => !s)} className={showAllMonths ? 'active' : ''}>
            {showAllMonths ? 'Mes selecionado' : 'Todos os meses'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void downloadReport('pdf')}
            disabled={exportBusy !== null}
            title="Exportar relatório PDF"
          >
            <FileText size={14} /> {exportBusy === 'pdf' ? 'A gerar…' : 'PDF'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void downloadReport('xlsx')}
            disabled={exportBusy !== null}
            title="Exportar dados em Excel"
          >
            <Download size={14} /> {exportBusy === 'xlsx' ? 'A gerar…' : 'Excel'}
          </Button>
        </div>
      </div>

      {exportError && <Message tone="error">{exportError}</Message>}
      {loadError && data.totals.count === 0 && <ErrorRetry message={loadError} onRetry={() => { void load(); }} />}

      <section
        className={`operations-brief${briefAttention ? ' operations-brief-attention' : ''}`}
        aria-label="Resumo de rentabilidade"
      >
        <div className="operations-brief-main">
          <p className="eyebrow">Estado do portfólio</p>
          <p>{briefSentence}</p>
        </div>
        <dl className="operations-brief-rail">
          <div>
            <dt>Investimentos</dt>
            <dd>{data.totals.count}</dd>
          </div>
          <div>
            <dt>Por recuperar</dt>
            <dd>{notRecovered}</dd>
          </div>
          <div>
            <dt>OPEX médio</dt>
            <dd>{formatCompactCve(data.companyOpexShare.avgMonthlyOpex)}</dd>
          </div>
          <div>
            <dt>Clientes ativos</dt>
            <dd>{activeClients}</dd>
          </div>
        </dl>
      </section>

      <MetricGrid label="Indicadores de rentabilidade">
        <MetricCard
          icon={Wallet}
          label="Total investido"
          value={formatCve(data.totals.totalInvestedCve)}
          trend="stock + investimentos"
          tone="info"
        />
        <MetricCard
          icon={RadioTower}
          label="Backbone / transmissão"
          value={formatCve(data.totals.backboneStockCve)}
          trend="infraestrutura de sinal"
          tone="info"
        />
        <MetricCard
          icon={Banknote}
          label="Faturação mensal"
          value={formatCve(data.totals.totalActualRevenueCve)}
          trend="receita do portfólio"
          tone="revenue"
        />
        <MetricCard
          icon={Percent}
          label="ROI médio"
          value={data.totals.averageRoiPct === null ? '—' : `${data.totals.averageRoiPct.toFixed(1)}%`}
          trend={data.totals.lowRoiCount > 0 ? `${data.totals.lowRoiCount} abaixo do alvo` : 'dentro do alvo'}
          tone={data.totals.lowRoiCount > 0 ? 'danger' : 'neutral'}
        />
        <MetricCard
          icon={Coins}
          label="Lucro acumulado"
          value={formatCve(data.totals.companyAccumulatedProfitCve)}
          trend="recebido − investido − despesas"
          tone={data.totals.companyAccumulatedProfitCve < 0 ? 'danger' : 'success'}
        />
      </MetricGrid>

      {revenuePoints.length > 0 && (
        <Card
          eyebrow="Rentabilidade do portfólio"
          title={String(new Date().getFullYear())}
          className="dashboard-card-chart investment-flagship"
        >
          <RevenueBars points={revenuePoints} ariaLabel="Receita, investimentos e despesas dos ultimos 12 meses" />
        </Card>
      )}

      {data.alerts.length > 0 && (
        <div className="investment-alerts">
          {data.alerts.map((alert, idx) => (
            <span key={`${alert.severity}-${alert.message}-${idx}`} className={`alert-${alert.severity}`}>
              {alert.target && <strong>{alert.target.name}:</strong>} {alert.message}
            </span>
          ))}
        </div>
      )}

      <Card
        eyebrow="Análise anual"
        title="Investimento x retorno anual"
        className="investment-return-panel"
        actions={<span className="investment-return-caption">Retorno anual = lucro mensal líquido × 12</span>}
      >
        {investmentReturnRows.length > 0 ? (
          <div className="investment-return-chart">
            {investmentReturnRows.map((row) => (
              <div className="investment-return-row" key={row.id}>
                <div className="investment-return-name">
                  <strong>{row.name}</strong>
                  <small>{row.roi === null ? 'ROI sem dados' : `ROI anual ${row.roi.toFixed(1)}%`}</small>
                </div>
                <div className="investment-return-bars">
                  <div className="investment-return-barline">
                    <span>Investido</span>
                    <div><i className="bar-invested" style={{ width: `${row.investedPct}%` }} /></div>
                    <b>{formatCve(row.invested)}</b>
                  </div>
                  <div className="investment-return-barline">
                    <span>Retorno ano</span>
                    <div>
                      <i
                        className={row.annualReturn >= 0 ? 'bar-return-positive' : 'bar-return-negative'}
                        style={{ width: `${row.annualReturnPct}%` }}
                      />
                    </div>
                    <b>{formatCve(row.annualReturn)}</b>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Message>Registe investimentos para comparar capital aplicado e retorno anual.</Message>
        )}
      </Card>
    </section>
  );
}
