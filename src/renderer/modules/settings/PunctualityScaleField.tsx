import { useEffect, useState } from 'react';
import { Field, Select } from '../../components';
import { authFetch } from '../../lib/auth';
import {
  DELAY_LIMIT_RANGE, PAYMENT_CLASS_LETTERS, PUNCTUALITY_SCALES, PUNCTUALITY_SCALE_CODES,
  PUNCTUALITY_SCALE_LABELS, type PaymentClass, type PunctualityScale
} from '../../../shared/payment-score';

/**
 * A escala com que a classificação de clientes julga quem paga tarde.
 *
 * Ao lado da escolha, o que cada escala faria à carteira de hoje: sem os
 * números, "generosa" e "exigente" são duas palavras que ninguém consegue
 * avaliar. Se a carteira ainda não der para classificar ninguém — instalação
 * nova, ou nenhum cliente com três mensalidades —, ficam os escalões.
 */

type ScaleDistribution = {
  scale: PunctualityScale;
  classified: number;
  distribution: Record<PaymentClass, number>;
};

/** `≤5d 70% · ≤15d 40% · ≤30d 15%`, ou a frase de quem não perdoa um dia. */
export function ladderOf(scale: PunctualityScale): string {
  const steps = PUNCTUALITY_SCALES[scale].filter(([days, credit]) => days > 0 && credit > 0);
  if (steps.length === 0) return 'só contam as pagas até ao vencimento';
  return steps.map(([days, credit]) => `≤${days}d ${Math.round(credit * 100)}%`).join(' · ');
}

export function PunctualityScaleField({
  value, onChange, delayLimitDays, onChangeDelayLimit
}: {
  value: PunctualityScale;
  onChange: (scale: PunctualityScale) => void;
  delayLimitDays: string;
  onChangeDelayLimit: (days: string) => void;
}) {
  const [scales, setScales] = useState<ScaleDistribution[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await authFetch('http://127.0.0.1:3001/api/finance/payment-scales');
        if (!response.ok) return;
        const body = await response.json() as { scales: ScaleDistribution[] };
        if (alive) setScales(body.scales);
      } catch {
        // Sem a carteira a comparação não aparece; a escolha continua a fazer-se.
      }
    })();
    return () => { alive = false; };
  }, []);

  const classified = scales?.[0]?.classified ?? 0;

  return (
    <div className="scale-field wide-field">
      <div className="scale-field-rules">
        <Select
          label="Escala da pontualidade"
          value={value}
          onChange={(event) => onChange(event.target.value as PunctualityScale)}
        >
          {PUNCTUALITY_SCALE_CODES.map((scale) => (
            <option key={scale} value={scale}>
              {PUNCTUALITY_SCALE_LABELS[scale]} — {ladderOf(scale)}
            </option>
          ))}
        </Select>
        <Field
          label="Atraso médio que vale zero (dias)"
          type="number"
          min={DELAY_LIMIT_RANGE.min}
          max={DELAY_LIMIT_RANGE.max}
          value={delayLimitDays}
          onChange={(event) => onChangeDelayLimit(event.target.value)}
        />
      </div>
      {/* A dica é das duas regras: mexer em qualquer uma reescreve as letras. */}
      <span className="field-hint">Mudam as letras de todos os clientes, histórico incluído.</span>

      <table className="scale-compare">
        <caption>{classified > 0 ? `A sua carteira, ${classified} classificados` : 'O que cada escala perdoa'}</caption>
        <thead>
          <tr>
            <th scope="col">Escala</th>
            {classified > 0
              ? PAYMENT_CLASS_LETTERS.map((letter) => <th key={letter} scope="col">{letter}</th>)
              : <th scope="col">Crédito por atraso</th>}
          </tr>
        </thead>
        <tbody>
          {PUNCTUALITY_SCALE_CODES.map((scale) => {
            const row = scales?.find((entry) => entry.scale === scale);
            return (
              <tr key={scale} className={scale === value ? 'is-chosen' : undefined}>
                <th scope="row">{PUNCTUALITY_SCALE_LABELS[scale]}</th>
                {classified > 0 && row
                  ? PAYMENT_CLASS_LETTERS.map((letter) => (
                      <td key={letter}>{row.distribution[letter] || '—'}</td>
                    ))
                  : <td className="scale-ladder">{ladderOf(scale)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
