import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { PUNCTUALITY_SCALE_CODES } from '../../../shared/payment-score';
import { PunctualityScaleField, ladderOf } from './PunctualityScaleField';

/**
 * O painel desenha-se sem a carteira: numa instalação nova, ou se a leitura
 * falhar, a escolha continua a fazer-se e cada escala diz o que perdoa.
 */
const markup = (value: Parameters<typeof PunctualityScaleField>[0]['value'] = 'exigente') =>
  renderToStaticMarkup(
    <PunctualityScaleField
      value={value}
      onChange={vi.fn()}
      delayLimitDays="15"
      onChangeDelayLimit={vi.fn()}
    />
  );

describe('escala da pontualidade nas Configurações', () => {
  test('oferece as três escalas', () => {
    const html = markup();
    for (const scale of PUNCTUALITY_SCALE_CODES) expect(html).toContain(`value="${scale}"`);
    expect(html).toContain('Tudo ou nada');
    expect(html).toContain('Generosa');
    expect(html).toContain('Exigente');
  });

  test('avisa que a mudança é retroativa', () => {
    expect(markup()).toContain('Muda as letras de todos os clientes, histórico incluído.');
  });

  test('a escolhida fica marcada na comparação', () => {
    expect(markup('generosa')).toContain('class="is-chosen"');
  });

  test('sem carteira mostra o que cada escala perdoa', () => {
    const html = markup();
    expect(html).toContain('O que cada escala perdoa');
    expect(html).toContain('só contam as pagas até ao vencimento');
  });
});

describe('o resumo de uma escala', () => {
  test('tudo ou nada não perdoa um único dia', () => {
    expect(ladderOf('tudo_ou_nada')).toBe('só contam as pagas até ao vencimento');
  });

  test('as graduadas escrevem-se por degrau', () => {
    expect(ladderOf('exigente')).toBe('≤5d 70% · ≤15d 40% · ≤30d 15%');
    expect(ladderOf('generosa')).toBe('≤5d 85% · ≤15d 60% · ≤30d 35%');
  });
});

describe('limite do atraso nas Configurações', () => {
  test('mostra o valor em vigor num campo próprio', () => {
    const html = markup();
    expect(html).toContain('Atraso médio que vale zero (dias)');
    expect(html).toContain('value="15"');
  });
});
