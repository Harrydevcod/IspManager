import { apiUrl } from '../../lib/api';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, EmptyState, ErrorRetry, SkeletonList } from '../../components';
import { authFetch } from '../../lib/auth';
import { downloadCsv } from '../../lib/csv';
import { formatCve, formatPtMonth } from '../../lib/format';
import { ScorePill, TrendIcon } from '../finance/ScorePill';
import { PAYMENT_CLASS_LETTERS, classInfo } from '../../../shared/payment-score';
import type { ClientBehaviour, PaymentBehaviourReport, PortfolioPoint } from '../../types';

/**
 * O comportamento da carteira, para quem lê relatórios e não linhas.
 *
 * Painel com vida própria, como o da Operação: traz os seus dados, exporta o
 * seu CSV e não acrescenta um ramo ao `if` já comprido do `ReportsModule`.
 */

const API = apiUrl('/api');

type Dados = { report: PaymentBehaviourReport; months: PortfolioPoint[] };

export function BehaviourReportPanel() {
  const [dados, setDados] = useState<Dados | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    void (async () => {
      try {
        const [a, b] = await Promise.all([
          authFetch(`${API}/finance/payment-behaviour`),
          authFetch(`${API}/finance/payment-behaviour/history`)
        ]);
        if (!a.ok || !b.ok) throw new Error('resposta inesperada');
        const report = await a.json() as PaymentBehaviourReport;
        const { months } = await b.json() as { months: PortfolioPoint[] };
        if (alive) setDados({ report, months });
      } catch {
        if (alive) setLoadError('Não foi possível carregar o comportamento da carteira.');
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (loadError) return <ErrorRetry message={loadError} onRetry={() => setTick((n) => n + 1)} />;
  if (!dados) return <SkeletonList rows={6} />;

  const { report, months } = dados;
  const { totals } = report;
  const porClasse = PAYMENT_CLASS_LETTERS.map((letter) => {
    const linhas = report.clients.filter((c) => c.letter === letter);
    return {
      letter,
      clientes: linhas.length,
      scoreMedio: linhas.length
        ? Math.round(linhas.reduce((sum, c) => sum + c.score, 0) / linhas.length)
        : 0,
      pontualidade: linhas.length
        ? Math.round(linhas.reduce((sum, c) => sum + c.punctualityPct, 0) / linhas.length)
        : 0,
      vencidoCve: totals.overdueByClass[letter]
    };
  });

  const mudaram = (trend: ClientBehaviour['trend']) =>
    report.clients.filter((c) => c.trend === trend);
  const melhoraram = mudaram('up');
  const pioraram = mudaram('down');

  function exportar() {
    downloadCsv('ispm-relatorio-comportamento.csv', [
      ['Classe', 'Descricao', 'Clientes', 'Pontuacao media', 'Pontualidade %', 'Vencido CVE'],
      ...porClasse.map((linha) => [
        linha.letter, classInfo(linha.letter).label, linha.clientes,
        linha.scoreMedio, linha.pontualidade, linha.vencidoCve
      ]),
      [],
      ['Mes', 'Classificados', 'Pontuacao media', ...PAYMENT_CLASS_LETTERS],
      ...months.map((m) => [
        m.month, m.classified, m.avgScore,
        ...PAYMENT_CLASS_LETTERS.map((letter) => m.distribution[letter])
      ])
    ]);
  }

  if (totals.classified === 0) {
    return (
      <EmptyState
        title="Ninguém classificado ainda"
        description="A letra nasce na primeira mensalidade vencida ou paga."
      />
    );
  }

  return (
    <div className="behaviour-report">
      <div className="behaviour-report-actions">
        <span className="behaviour-report-rules">
          {report.clients.length} clientes · {totals.classified} com letra · média {totals.avgScore}
        </span>
        <Button variant="secondary" size="sm" onClick={exportar}>
          <Download size={15} aria-hidden /> Exportar CSV
        </Button>
      </div>

      <div className="behaviour-report-scroll">
      <table className="behaviour-report-table">
        <caption>A carteira por classe</caption>
        <thead>
          <tr>
            <th scope="col">Classe</th>
            <th scope="col">Clientes</th>
            <th scope="col">Pontuação média</th>
            <th scope="col">Pontualidade</th>
            <th scope="col">Vencido</th>
          </tr>
        </thead>
        <tbody>
          {porClasse.map((linha) => (
            <tr key={linha.letter}>
              <th scope="row"><ScorePill letter={linha.letter} /></th>
              <td>{linha.clientes}</td>
              <td>{linha.clientes ? linha.scoreMedio : '—'}</td>
              <td>{linha.clientes ? `${linha.pontualidade}%` : '—'}</td>
              <td>{linha.vencidoCve > 0 ? formatCve(linha.vencidoCve) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="behaviour-report-scroll">
      <table className="behaviour-report-table">
        <caption>Evolução dos últimos 12 meses</caption>
        <thead>
          <tr>
            <th scope="col">Mês</th>
            <th scope="col">Com letra</th>
            <th scope="col">Média</th>
            {PAYMENT_CLASS_LETTERS.map((letter) => <th key={letter} scope="col">{letter}</th>)}
          </tr>
        </thead>
        <tbody>
          {months.map((mes) => (
            <tr key={mes.month}>
              <th scope="row">{formatPtMonth(mes.month)}</th>
              <td>{mes.classified}</td>
              <td>{mes.classified ? mes.avgScore : '—'}</td>
              {PAYMENT_CLASS_LETTERS.map((letter) => (
                <td key={letter}>{mes.distribution[letter] || '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="behaviour-report-moved">
        {[
          { titulo: 'Pioraram no último mês', linhas: pioraram, trend: 'down' as const },
          { titulo: 'Melhoraram no último mês', linhas: melhoraram, trend: 'up' as const }
        ].map(({ titulo, linhas, trend }) => (
          <section key={trend} aria-label={titulo}>
            <h3><TrendIcon trend={trend} /> {titulo} ({linhas.length})</h3>
            {linhas.length === 0 ? (
              <p className="behaviour-report-none">Ninguém.</p>
            ) : (
              <ul>
                {linhas.map((cliente) => (
                  <li key={cliente.clientId}>
                    <strong>{cliente.clientName}</strong>
                    <ScorePill letter={cliente.letter} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
