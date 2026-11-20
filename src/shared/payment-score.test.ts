import { describe, expect, it } from 'vitest';
import {
  DELAY_SCALE_DAYS, MIN_EVALUATED, PAYMENT_CLASSES, SCORE_WEIGHTS,
  DEFAULT_PUNCTUALITY_SCALE, PUNCTUALITY_SCALES, PUNCTUALITY_SCALE_CODES,
  classFor, monthKeysEndingAt, outcomeFor, punctualityCredit, punctualityScaleOf,
  scoreClient, trendFor,
  type InvoiceFact, type PunctualityScale
} from './payment-score';

const AS_OF = '2026-11-19';

/** Mensalidade de 2.500$ com vencimento no dia dado e os recibos que indicar. */
function invoice(dueDate: string, receipts: Array<[string, number]> = [], amountCve = 2500): InvoiceFact {
  return { dueDate, amountCve, receipts: receipts.map(([date, amountCve]) => ({ date, amountCve })) };
}

/** `n` mensalidades mensais seguidas, a vencer no dia 10, a mais antiga primeiro. */
function monthly(count: number, lastMonth: string, lateDays: (index: number) => number): InvoiceFact[] {
  const [year, month] = lastMonth.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(year, month - 1 - (count - 1 - i), 10));
    const due = at.toISOString().slice(0, 10);
    const late = lateDays(i);
    const paid = new Date(at.getTime() + late * 86_400_000).toISOString().slice(0, 10);
    return invoice(due, [[paid, 2500]]);
  });
}

describe('pesos', () => {
  it('somam 100', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });

  it('as classes cobrem a escala inteira, da mais alta para a mais baixa', () => {
    expect(PAYMENT_CLASSES.map((c) => c.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(PAYMENT_CLASSES[PAYMENT_CLASSES.length - 1].minScore).toBe(0);
    expect(classFor(100).letter).toBe('A');
    expect(classFor(0).letter).toBe('E');
  });
});

describe('escalão da pontualidade', () => {
  const credit = (daysLate: number, settled = true, scale?: PunctualityScale) =>
    punctualityCredit(
      { dueDate: '2026-11-10', settled, settledOn: settled ? '2026-11-10' : null, daysLate, onTime: daysLate <= 0 && settled },
      scale
    );

  it('pagar ao vencimento vale tudo em qualquer escala', () => {
    for (const scale of PUNCTUALITY_SCALE_CODES) {
      expect(credit(0, true, scale)).toBe(1);
      expect(credit(-4, true, scale)).toBe(1);
    }
  });

  it('"tudo ou nada" não dá crédito a um único dia de atraso', () => {
    expect(credit(1, true, 'tudo_ou_nada')).toBe(0);
  });

  it('a generosa dá mais do que a exigente em todos os degraus de atraso', () => {
    for (const daysLate of [3, 10, 25]) {
      expect(credit(daysLate, true, 'generosa')).toBeGreaterThan(credit(daysLate, true, 'exigente'));
    }
  });

  it('nenhuma escala dá crédito acima de 30 dias', () => {
    for (const scale of PUNCTUALITY_SCALE_CODES) expect(credit(31, true, scale)).toBe(0);
  });

  it('o que estiver guardado só vale se for uma escala', () => {
    expect(punctualityScaleOf('generosa')).toBe('generosa');
    expect(punctualityScaleOf('')).toBe(DEFAULT_PUNCTUALITY_SCALE);
    expect(punctualityScaleOf('lixo')).toBe(DEFAULT_PUNCTUALITY_SCALE);
    expect(punctualityScaleOf('toString')).toBe(DEFAULT_PUNCTUALITY_SCALE);
    expect(punctualityScaleOf(undefined)).toBe(DEFAULT_PUNCTUALITY_SCALE);
  });

  it('cada escala acaba em zero, para nenhuma deixar um atraso sem resposta', () => {
    for (const ladder of Object.values(PUNCTUALITY_SCALES)) {
      expect(ladder[ladder.length - 1]).toEqual([Infinity, 0]);
    }
  });

  it('a de omissão dá crédito por escalão, e nada acima de 30 dias', () => {
    expect(credit(-3)).toBe(1);
    expect(credit(0)).toBe(1);
    expect(credit(5)).toBe(0.7);
    expect(credit(6)).toBe(0.4);
    expect(credit(15)).toBe(0.4);
    expect(credit(16)).toBe(0.15);
    expect(credit(30)).toBe(0.15);
    expect(credit(31)).toBe(0);
  });

  it('uma mensalidade por liquidar não ganha crédito, mesmo recente', () => {
    expect(credit(2, false)).toBe(0);
  });
});

describe('uma mensalidade de cada vez', () => {
  it('não venceu ainda: fica fora do cálculo', () => {
    expect(outcomeFor(invoice('2026-12-10'), AS_OF)).toBeNull();
  });

  it('pagamento antecipado conta como pontual', () => {
    const outcome = outcomeFor(invoice('2026-11-10', [['2026-11-05', 2500]]), AS_OF);
    expect(outcome).toMatchObject({ settled: true, onTime: true });
    expect(outcome?.daysLate).toBe(-5);
  });

  it('pago no próprio dia do vencimento é pontual', () => {
    expect(outcomeFor(invoice('2026-11-10', [['2026-11-10', 2500]]), AS_OF)).toMatchObject({
      daysLate: 0, onTime: true
    });
  });

  it('pagamento parcial não liquida enquanto houver saldo', () => {
    const outcome = outcomeFor(invoice('2026-10-10', [['2026-10-09', 1000]]), AS_OF);
    expect(outcome).toMatchObject({ settled: false, onTime: false, settledOn: null });
    // O atraso é o que já corre, contado até hoje.
    expect(outcome?.daysLate).toBe(40);
  });

  it('a data da liquidação é a do recibo que fechou o saldo, não a do último', () => {
    const outcome = outcomeFor(invoice('2026-10-10', [
      ['2026-10-05', 1000], ['2026-10-08', 1500], ['2026-10-30', 500]
    ]), AS_OF);
    expect(outcome?.settledOn).toBe('2026-10-08');
    expect(outcome?.onTime).toBe(true);
  });

  it('paga depois da suspensão: liquidada, mas o atraso fica no histórico', () => {
    expect(outcomeFor(invoice('2026-08-10', [['2026-09-25', 2500]]), AS_OF)).toMatchObject({
      settled: true, onTime: false, daysLate: 46
    });
  });

  it('recibo posterior à data de corte não conta: o passado não muda de resposta', () => {
    const row = invoice('2026-09-10', [['2026-11-01', 2500]]);
    expect(outcomeFor(row, '2026-10-01')).toMatchObject({ settled: false });
    expect(outcomeFor(row, AS_OF)).toMatchObject({ settled: true });
  });
});

describe('pontuação do cliente', () => {
  it('sem mensalidades avaliáveis não dá pontos de graça', () => {
    const score = scoreClient([invoice('2026-12-10')], AS_OF);
    expect(score).toMatchObject({ score: 0, letter: null, provisional: true, evaluated: 0 });
    expect(score.parts).toEqual({ punctuality: 0, delay: 0, settled: 0, regularity: 0 });
  });

  it(`abaixo de ${MIN_EVALUATED} mensalidades a classificação é provisória, sem letra`, () => {
    const score = scoreClient(monthly(2, '2026-11', () => 0), AS_OF);
    expect(score.evaluated).toBe(2);
    expect(score.provisional).toBe(true);
    expect(score.letter).toBeNull();
    expect(score.score).toBeGreaterThan(0);
  });

  it('cliente impecável durante 12 meses chega a 100 e a classe A', () => {
    const score = scoreClient(monthly(12, '2026-11', () => 0), AS_OF);
    expect(score).toMatchObject({ score: 100, letter: 'A', provisional: false, evaluated: 12, onTime: 12 });
  });

  it('9/12 pontuais com 2 dias de atraso médio dá 92 e a classe A', () => {
    // Os três atrasos ficam na metade antiga da janela, para os últimos 6 meses
    // continuarem limpos.
    //
    // O pedido original descrevia este caso como 87 pontos e classe B, com a
    // pontualidade a contar tudo-ou-nada. O escalão escolhido depois de medir a
    // carteira real dá crédito a quem paga com poucos dias de atraso, e os três
    // atrasos de 8 dias passam a valer 40% em vez de nada: 34 + 23,3 + 20 + 15.
    const invoices = monthly(12, '2026-11', (i) => (i < 3 ? 8 : 0));
    const score = scoreClient(invoices, AS_OF);
    expect(score.evaluated).toBe(12);
    expect(score.onTime).toBe(9);
    expect(score.settled).toBe(12);
    expect(score.punctualityPct).toBe(75);
    expect(score.avgDelayDays).toBe(2);
    expect(score.cleanMonths).toBe(6);
    expect(score.score).toBe(92);
    expect(score.letter).toBe('A');
  });

  it('paga sempre mas sempre tarde: a escala decide quão grave isso é', () => {
    // O caso que abriu a escolha das três escalas: seis mensalidades pagas,
    // nenhuma a horas, sempre a duas semanas do vencimento. Para a escala
    // "tudo ou nada" é igual a nunca ter pago.
    const invoices = monthly(6, '2026-09', () => 14);
    const base = scoreClient(invoices, AS_OF);
    expect(base.onTime).toBe(0);
    expect(base.settled).toBe(6);

    expect(scoreClient(invoices, AS_OF, 'tudo_ou_nada').letter).toBe('E');
    expect(scoreClient(invoices, AS_OF, 'generosa').letter).toBe('C');
    expect(scoreClient(invoices, AS_OF, 'exigente').letter).toBe('D');
    // Sem escolha, vale a de omissão.
    expect(base.letter).toBe(scoreClient(invoices, AS_OF, DEFAULT_PUNCTUALITY_SCALE).letter);
  });

  it('quem paga sempre a horas chega a 100 em qualquer escala', () => {
    const invoices = monthly(12, '2026-11', () => 0);
    for (const scale of PUNCTUALITY_SCALE_CODES) {
      expect(scoreClient(invoices, AS_OF, scale)).toMatchObject({ score: 100, letter: 'A' });
    }
  });

  it('uma escala mais dura nunca dá mais pontos do que uma mais branda', () => {
    const invoices = monthly(9, '2026-10', (i) => i * 3);
    const estrita = scoreClient(invoices, AS_OF, 'tudo_ou_nada').score;
    const exigente = scoreClient(invoices, AS_OF, 'exigente').score;
    const generosa = scoreClient(invoices, AS_OF, 'generosa').score;
    expect(estrita).toBeLessThanOrEqual(exigente);
    expect(exigente).toBeLessThanOrEqual(generosa);
  });

  it(`atraso médio de ${DELAY_SCALE_DAYS} dias ou mais anula esse critério`, () => {
    const score = scoreClient(monthly(6, '2026-09', () => DELAY_SCALE_DAYS + 5), AS_OF);
    expect(score.parts.delay).toBe(0);
    expect(score.onTime).toBe(0);
    expect(score.parts.punctuality).toBe(0);
    // Pagou tudo, ainda que tarde: o critério de liquidação continua cheio.
    expect(score.parts.settled).toBe(SCORE_WEIGHTS.settled);
  });

  it('quem nunca paga cai na classe E', () => {
    const invoices = monthly(6, '2026-11', () => 0).map((row) => ({ ...row, receipts: [] }));
    const score = scoreClient(invoices, AS_OF);
    expect(score.settled).toBe(0);
    expect(score.cleanMonths).toBe(0);
    expect(score.letter).toBe('E');
  });

  it('só olha para os últimos 12 meses', () => {
    const score = scoreClient([...monthly(3, '2026-11', () => 0), invoice('2024-01-10')], AS_OF);
    expect(score.evaluated).toBe(3);
  });

  it('um mês sem mensalidade exigível conta limpo', () => {
    // Serviço parado meio ano: as três mensalidades antigas foram pagas a horas.
    const score = scoreClient(monthly(3, '2026-05', () => 0), AS_OF);
    expect(score.evaluated).toBe(3);
    expect(score.cleanMonths).toBe(6);
  });
});

describe('tendência', () => {
  it('desce quando o cliente deixa de pagar há três meses', () => {
    const invoices = [
      ...monthly(9, '2026-08', () => 0),
      invoice('2026-09-10'), invoice('2026-10-10'), invoice('2026-11-10')
    ];
    expect(scoreClient(invoices, '2026-10-20').letter).toBe('B');
    expect(scoreClient(invoices, AS_OF).letter).toBe('C');
    expect(trendFor(invoices, AS_OF)).toBe('down');
  });

  it('um único deslize não derruba a classe de quem tem bom histórico', () => {
    const invoices = [...monthly(12, '2026-10', () => 0), invoice('2026-10-20')];
    expect(trendFor(invoices, AS_OF)).toBe('flat');
  });

  it('estável quando nada mudou de letra', () => {
    expect(trendFor(monthly(12, '2026-09', () => 0), AS_OF)).toBe('flat');
  });

  it('sem histórico bastante não se arrisca uma seta', () => {
    expect(trendFor(monthly(2, '2026-11', () => 0), AS_OF)).toBe('unknown');
  });
});

describe('meses observados', () => {
  it('termina no mês da data e vai do mais antigo ao mais recente', () => {
    expect(monthKeysEndingAt('2026-01-15', 3)).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});
