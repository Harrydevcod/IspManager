import { useEffect, useState } from 'react';
import { ErrorRetry, SkeletonList } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatPtMonth } from '../../lib/format';
import { ScorePill, TrendIcon } from './ScorePill';
import {
  PAYMENT_CONFIDENCE_LABELS, SCORE_WEIGHTS, classInfo
} from '../../../shared/payment-score';
import type { ClientBehaviourDetail } from '../../types';

/**
 * De onde vem a letra deste cliente, e como ela se moveu.
 *
 * O painel existe porque uma letra sem contas por baixo não se discute com o
 * cliente ao telefone. Os quatro critérios aparecem com os pontos que deram e
 * os que podiam ter dado: é a diferença que explica a classe.
 */

const CRITERIA = [
  { key: 'punctuality', label: 'Pontualidade' },
  { key: 'delay', label: 'Atraso médio' },
  { key: 'settled', label: 'Mensalidades liquidadas' },
  { key: 'regularity', label: 'Regularidade recente' }
] as const;

export function ClientBehaviourPanel({ clientId }: { clientId: number }) {
  const [detail, setDetail] = useState<ClientBehaviourDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    void (async () => {
      try {
        const response = await authFetch(
          `http://127.0.0.1:3001/api/finance/payment-behaviour/${clientId}`
        );
        if (!response.ok) throw new Error('resposta inesperada');
        const body = await response.json() as ClientBehaviourDetail;
        if (alive) setDetail(body);
      } catch {
        if (alive) setLoadError('Não foi possível carregar o comportamento de pagamento.');
      }
    })();
    return () => { alive = false; };
  }, [clientId]);

  if (loadError) return <ErrorRetry message={loadError} onRetry={() => setDetail(null)} />;
  if (!detail) return <SkeletonList rows={4} />;

  const semNada = detail.letter === null;

  return (
    <div className="client-behaviour">
      <div className="client-behaviour-head">
        <ScorePill letter={detail.letter} />
        {!semNada && <b className="client-behaviour-score">{detail.score}</b>}
        <TrendIcon trend={detail.trend} />
        {detail.confidence && (
          <span className="client-behaviour-confidence">
            Confiança {PAYMENT_CONFIDENCE_LABELS[detail.confidence].toLowerCase()}
            {' · '}{detail.evaluated} mensalidades avaliadas
          </span>
        )}
      </div>

      {semNada ? (
        <p className="client-behaviour-empty">
          Sem mensalidade vencida nem paga. A letra nasce na primeira das duas.
        </p>
      ) : (
        <>
          {detail.letter && <p className="client-behaviour-action">{classInfo(detail.letter).action}</p>}

          <table className="client-behaviour-parts">
            <caption>De onde vêm os {detail.score} pontos</caption>
            <thead>
              <tr>
                <th scope="col">Critério</th>
                <th scope="col">Pontos</th>
                <th scope="col">De</th>
              </tr>
            </thead>
            <tbody>
              {CRITERIA.map(({ key, label }) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td>{Math.round(detail.parts[key] * 10) / 10}</td>
                  <td>{SCORE_WEIGHTS[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="client-behaviour-facts">
            <div><dt>Pagas a horas</dt><dd>{detail.onTime} de {detail.evaluated}</dd></div>
            <div><dt>Atraso médio</dt><dd>{detail.avgDelayDays} dias</dd></div>
            <div><dt>Liquidadas</dt><dd>{detail.settled} de {detail.evaluated}</dd></div>
            <div><dt>Nos últimos 6 meses</dt><dd>{detail.recentEvaluated} avaliáveis</dd></div>
          </dl>
        </>
      )}

      <div className="client-behaviour-history" aria-label="Evolução dos últimos 12 meses">
        <span className="client-behaviour-history-label">Últimos 12 meses</span>
        <ol>
          {detail.history.map((point) => (
            <li
              key={point.month}
              className={point.letter ? `is-${point.letter.toLowerCase()}` : 'is-none'}
              title={point.letter
                ? `${formatPtMonth(point.month)}: ${point.letter}, ${point.score} pontos, ${point.evaluated} avaliadas`
                : `${formatPtMonth(point.month)}: sem nada para julgar`}
            >
              <span className="client-behaviour-history-month">{point.month.slice(5)}</span>
              <span className="client-behaviour-history-letter">{point.letter ?? '·'}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
