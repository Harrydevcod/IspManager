import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { classInfo, type PaymentClass, type PaymentTrend } from '../../../shared/payment-score';

/**
 * A letra de um cliente, e se está a melhorar ou a piorar.
 *
 * A ação recomendada vai no `title` e não no ecrã: quem cobra precisa de ver
 * trinta linhas de uma vez, não de ler um parágrafo por cliente.
 */
export function ScorePill({ letter }: { letter: PaymentClass | null }) {
  if (!letter) {
    // Não é falta de histórico — é não haver ainda nada para julgar: nenhuma
    // mensalidade vencida e nenhuma paga. Basta uma das duas para ganhar letra.
    // Duas palavras, porque a coluna da classe tem 116 px: "Aguarda avaliação"
    // dava 118 e saía cortada. O que falta para haver letra vai no `title`.
    return (
      <span className="score-pill is-none" title="Sem mensalidade vencida nem paga">
        Por avaliar
      </span>
    );
  }
  const info = classInfo(letter);
  return (
    // A letra não vai num <b>: a tabela empilha `span:has(> b)` numa grelha de
    // duas linhas, que é o padrão "valor com legenda por baixo" — aqui partia a
    // pílula ao meio e duplicava a altura da linha.
    <span className={`score-pill is-${letter.toLowerCase()}`} title={info.action}>
      <span className="score-letter">{letter}</span>
      {info.label}
    </span>
  );
}

const TRENDS = {
  up: { Icon: TrendingUp, tone: 'up', label: 'A melhorar' },
  down: { Icon: TrendingDown, tone: 'down', label: 'A piorar' },
  flat: { Icon: Minus, tone: 'flat', label: 'Sem mudança' }
} as const;

export function TrendIcon({ trend }: { trend: PaymentTrend }) {
  if (trend === 'unknown') return <span className="score-trend is-unknown" title="Sem histórico para comparar">—</span>;
  const { Icon, tone, label } = TRENDS[trend];
  return (
    <span className={`score-trend is-${tone}`} title={label}>
      <Icon size={14} aria-label={label} />
    </span>
  );
}
