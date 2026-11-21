import { daysApart, dayStartUtc } from './date';
import { isSettled } from './money';

/**
 * Comportamento de pagamento: de quem é que se pode confiar.
 *
 * A carteira já diz quanto cada cliente deve hoje. Não dizia nada sobre o
 * passado — quem atrasou dez vezes e acabou por pagar era indistinguível de
 * quem nunca atrasou. Aqui nasce uma pontuação de 0 a 100 e uma letra.
 *
 * **Nada disto se grava.** A pontuação é função pura das mensalidades e dos
 * recibos, que já são imutáveis e datados. Por isso `asOf` não é um extra: é o
 * que deixa a mesma função responder "que classe tinha este cliente há 30
 * dias" sem uma única linha de histórico em tabela.
 */

export const PAYMENT_CLASS_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type PaymentClass = (typeof PAYMENT_CLASS_LETTERS)[number];

export type PaymentClassInfo = {
  letter: PaymentClass;
  label: string;
  /** Pontuação mínima para a letra. */
  minScore: number;
  /** Uma linha: o que fazer com um cliente destes. Não é explicação, é ação. */
  action: string;
};

export const PAYMENT_CLASSES: readonly PaymentClassInfo[] = [
  { letter: 'A', label: 'Excelente', minScore: 90, action: 'Elegível para fidelização e campanhas.' },
  { letter: 'B', label: 'Bom', minScore: 75, action: 'Manter condições e lembretes normais.' },
  { letter: 'C', label: 'Regular', minScore: 60, action: 'Avisar antes do vencimento.' },
  { letter: 'D', label: 'Irregular', minScore: 40, action: 'Acompanhar a cobrança de perto.' },
  { letter: 'E', label: 'Crítico', minScore: 0, action: 'Gerir a dívida e rever as condições.' }
];

/** Peso de cada critério. Somam 100 — o teste trava qualquer mexida que o esqueça. */
export const SCORE_WEIGHTS = { punctuality: 40, delay: 25, settled: 20, regularity: 15 } as const;

/**
 * O que vale pagar tarde — e isto escolhe-se em Configurações › Faturação.
 *
 * Pagar ao vencimento vale sempre tudo; o que muda entre as três escalas é
 * quanto vale pagar com atraso. Medido na carteira real antes de abrir a
 * escolha: com "tudo ou nada", quem paga todos os meses mas sempre com duas
 * semanas de atraso caía em "Crítico", ao lado de quem não paga.
 *
 * "Tudo ou nada" é uma escada como as outras, com um só degrau — três nomes,
 * um caminho de código.
 */
export type PunctualityScale = 'tudo_ou_nada' | 'generosa' | 'exigente';

export type PunctualityLadder = ReadonlyArray<readonly [maxDaysLate: number, credit: number]>;

export const PUNCTUALITY_SCALES: Record<PunctualityScale, PunctualityLadder> = {
  tudo_ou_nada: [[0, 1], [Infinity, 0]],
  generosa: [[0, 1], [5, 0.85], [15, 0.6], [30, 0.35], [Infinity, 0]],
  exigente: [[0, 1], [5, 0.7], [15, 0.4], [30, 0.15], [Infinity, 0]]
};

export const PUNCTUALITY_SCALE_LABELS: Record<PunctualityScale, string> = {
  tudo_ou_nada: 'Tudo ou nada',
  generosa: 'Generosa',
  exigente: 'Exigente'
};

export const PUNCTUALITY_SCALE_CODES = Object.keys(PUNCTUALITY_SCALES) as PunctualityScale[];

/** A escala escolhida na carteira real a 20/11/2026, e a de quem nunca escolher. */
export const DEFAULT_PUNCTUALITY_SCALE: PunctualityScale = 'exigente';

export function isPunctualityScale(value: unknown): value is PunctualityScale {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PUNCTUALITY_SCALES, value);
}

/** O que estiver guardado, se for uma escala; senão a de omissão. */
export function punctualityScaleOf(value: unknown): PunctualityScale {
  return isPunctualityScale(value) ? value : DEFAULT_PUNCTUALITY_SCALE;
}

/** Atraso médio a partir do qual esse critério vale zero; escolhe-se em Configurações › Faturação. */
export const DEFAULT_DELAY_LIMIT_DAYS = 15;
/** Limites do que se pode escolher: um limite de um dia fazia qualquer atraso valer zero. */
export const DELAY_LIMIT_RANGE = { min: 5, max: 90 } as const;
/** Meses que a regularidade recente observa. */
export const REGULARITY_MONTHS = 6;
/** Janela de histórico que a pontuação observa. */
export const SCORE_WINDOW_MONTHS = 12;
/** Distância a que se mede a tendência. */
export const TREND_DAYS = 30;

/** As duas regras que se escolhem; tudo o mais na fórmula é fixo. */
export type ScoreRules = { scale: PunctualityScale; delayLimitDays: number };

export const DEFAULT_SCORE_RULES: ScoreRules = {
  scale: DEFAULT_PUNCTUALITY_SCALE,
  delayLimitDays: DEFAULT_DELAY_LIMIT_DAYS
};

/** O que estiver guardado, dentro dos limites; lixo cai na omissão. */
export function delayLimitOf(value: unknown): number {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days)) return DEFAULT_DELAY_LIMIT_DAYS;
  return Math.min(DELAY_LIMIT_RANGE.max, Math.max(DELAY_LIMIT_RANGE.min, days));
}

export const PAYMENT_CONFIDENCE_CODES = ['inicial', 'em_formacao', 'consolidada', 'elevada'] as const;
export type PaymentConfidence = (typeof PAYMENT_CONFIDENCE_CODES)[number];

export const PAYMENT_CONFIDENCE_LABELS: Record<PaymentConfidence, string> = {
  inicial: 'Inicial',
  em_formacao: 'Em formação',
  consolidada: 'Consolidada',
  elevada: 'Elevada'
};

/**
 * Quanta mensalidade sustenta a letra — e nada mais do que isso: não entra na
 * pontuação nem na categoria.
 *
 * É o que separa um 100 tirado de uma mensalidade de um 100 tirado de doze. A
 * classificação começa na primeira mensalidade avaliável, por decisão do
 * utilizador; a maturidade do histórico diz-se aqui, à vista, em vez de se
 * esconder a letra até haver três faturas.
 */
export function confidenceFor(evaluated: number): PaymentConfidence | null {
  if (evaluated <= 0) return null;
  if (evaluated <= 2) return 'inicial';
  if (evaluated <= 5) return 'em_formacao';
  if (evaluated <= 11) return 'consolidada';
  return 'elevada';
}

/**
 * O estado de hoje, que não se mistura com a letra: um cliente de classe A pode
 * ter uma fatura vencida esta semana sem perder o histórico que construiu.
 */
export type FinancialState = 'em_dia' | 'vencido' | 'suspenso';

export const FINANCIAL_STATE_LABELS: Record<FinancialState, string> = {
  em_dia: 'Em dia',
  vencido: 'Vencido',
  suspenso: 'Suspenso'
};

export type ReceiptFact = { date: string; amountCve: number };

/** Uma mensalidade e o dinheiro que entrou por ela. Valores em escudos. */
export type InvoiceFact = { dueDate: string; amountCve: number; receipts: ReceiptFact[] };

export type InvoiceOutcome = {
  dueDate: string;
  settled: boolean;
  settledOn: string | null;
  /** Negativo quando pagou adiantado. */
  daysLate: number;
  onTime: boolean;
};

export type ScoreParts = { punctuality: number; delay: number; settled: number; regularity: number };

export type PaymentScore = {
  score: number;
  /** `null` só sem nada para julgar: aí o cliente aguarda a primeira avaliação. */
  letter: PaymentClass | null;
  confidence: PaymentConfidence | null;
  evaluated: number;
  onTime: number;
  settled: number;
  punctualityPct: number;
  avgDelayDays: number;
  /** Denominador da regularidade recente — zero tira esse critério da conta. */
  recentEvaluated: number;
  parts: ScoreParts;
};

const EMPTY_SCORE: PaymentScore = {
  score: 0, letter: null, confidence: null, evaluated: 0, onTime: 0, settled: 0,
  punctualityPct: 0, avgDelayDays: 0, recentEvaluated: 0,
  parts: { punctuality: 0, delay: 0, settled: 0, regularity: 0 }
};

/** `AAAA-MM-DD` n meses antes da data dada. */
export function monthsBefore(iso: string, months: number): string {
  const at = dayStartUtc(iso);
  if (at === null) return iso;
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Os n meses (`AAAA-MM`) que terminam no mês da data dada, do mais antigo ao mais recente. */
export function monthKeysEndingAt(iso: string, months: number): string[] {
  const at = dayStartUtc(iso);
  if (at === null) return [];
  const keys: string[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const d = new Date(at);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - back);
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys;
}

/**
 * O que aconteceu a uma mensalidade até `asOf`. `null` quando não há nada a
 * julgar: ainda não venceu e também ainda não foi paga.
 *
 * Uma mensalidade liquidada julga-se sempre, mesmo antes de vencer — é o que
 * faz a primeira mensalidade paga adiantado valer uma letra desde logo, em vez
 * de ficar à espera do vencimento para dizer o que já se sabe.
 *
 * Liquidada é quando a soma corrida dos recibos cobre o devido — e o dia em que
 * isso acontece é o do recibo que fechou o saldo, não o do último que entrou.
 * Um recibo posterior a `asOf` fica de fora, senão o passado mudava de resposta.
 */
export function outcomeFor(invoice: InvoiceFact, asOf: string): InvoiceOutcome | null {
  const due = dayStartUtc(invoice.dueDate);
  const at = dayStartUtc(asOf);
  if (due === null || at === null) return null;

  let received = 0;
  let settledOn: string | null = null;
  const ordered = [...invoice.receipts].sort((a, b) => a.date.localeCompare(b.date));
  for (const receipt of ordered) {
    const paid = dayStartUtc(receipt.date);
    if (paid === null || paid > at) continue;
    received += receipt.amountCve;
    if (settledOn === null && isSettled(invoice.amountCve - received)) settledOn = receipt.date;
  }

  if (due > at && settledOn === null) return null;

  // Por pagar: o atraso é o que já corre, contado até à data de corte.
  const reference = settledOn ?? asOf;
  const daysLate = daysApart(invoice.dueDate, reference) ?? 0;
  return {
    dueDate: invoice.dueDate,
    settled: settledOn !== null,
    settledOn,
    daysLate,
    onTime: settledOn !== null && daysLate <= 0
  };
}

/**
 * A pontuação de um cliente na data dada — desde a primeira mensalidade
 * avaliável, sem histórico mínimo.
 *
 * Sem nada para julgar devolve zeros e letra nenhuma, nunca pontos de graça:
 * três dos quatro critérios dariam nota máxima a um cliente que nunca teve nada
 * para pagar.
 */
export function scoreClient(
  invoices: InvoiceFact[],
  asOf: string,
  rules: Partial<ScoreRules> = {}
): PaymentScore {
  const { scale, delayLimitDays } = { ...DEFAULT_SCORE_RULES, ...rules };
  const from = monthsBefore(asOf, SCORE_WINDOW_MONTHS);
  const outcomes = invoices
    .filter((invoice) => invoice.dueDate >= from)
    .map((invoice) => outcomeFor(invoice, asOf))
    .filter((outcome): outcome is InvoiceOutcome => outcome !== null);

  const evaluated = outcomes.length;
  if (evaluated === 0) return EMPTY_SCORE;

  const onTime = outcomes.filter((outcome) => outcome.onTime).length;
  const settled = outcomes.filter((outcome) => outcome.settled).length;
  const delays = outcomes.map((outcome) => Math.max(0, outcome.daysLate));
  const avgDelay = delays.reduce((sum, days) => sum + days, 0) / evaluated;
  const credit = outcomes.reduce((sum, outcome) => sum + punctualityCredit(outcome, scale), 0);

  // Regularidade recente: o mesmo crédito da pontualidade, restrito aos últimos
  // meses. Mede se o comportamento de agora confirma ou desmente o do ano todo.
  const recentFrom = monthsBefore(asOf, REGULARITY_MONTHS);
  const recent = outcomes.filter((outcome) => outcome.dueDate >= recentFrom);
  const recentCredit = recent.reduce((sum, outcome) => sum + punctualityCredit(outcome, scale), 0);

  // Um critério sem denominador sai da fórmula e os pesos restantes escalam
  // para continuar a somar 100. Só a regularidade recente pode ficar sem ele —
  // serviço parado ou cancelado há mais de meio ano. Dar-lhe nota máxima era
  // premiar quem já não fatura; dar-lhe zero era castigá-lo por isso.
  const measured: Array<readonly [keyof ScoreParts, number]> = [
    ['punctuality', credit / evaluated],
    ['delay', Math.max(0, 1 - avgDelay / delayLimitDays)],
    ['settled', settled / evaluated],
    ...(recent.length > 0 ? [['regularity', recentCredit / recent.length] as const] : [])
  ];
  const weight = measured.reduce((sum, [key]) => sum + SCORE_WEIGHTS[key], 0);

  const parts: ScoreParts = { punctuality: 0, delay: 0, settled: 0, regularity: 0 };
  for (const [key, ratio] of measured) parts[key] = ((SCORE_WEIGHTS[key] * 100) / weight) * ratio;
  const total = parts.punctuality + parts.delay + parts.settled + parts.regularity;
  const score = Math.min(100, Math.max(0, Math.round(total)));

  return {
    score,
    letter: classFor(score).letter,
    confidence: confidenceFor(evaluated),
    evaluated,
    onTime,
    settled,
    punctualityPct: Math.round((onTime / evaluated) * 100),
    avgDelayDays: Math.round(avgDelay * 10) / 10,
    recentEvaluated: recent.length,
    parts
  };
}

/**
 * Quanto conta uma mensalidade para a pontualidade, entre 0 e 1.
 *
 * Uma mensalidade por liquidar não ganha crédito em escala nenhuma: o atraso
 * dela ainda está a correr, e o escalão premiava-a por isso.
 */
export function punctualityCredit(
  outcome: InvoiceOutcome,
  scale: PunctualityScale = DEFAULT_PUNCTUALITY_SCALE
): number {
  if (!outcome.settled) return 0;
  const late = Math.max(0, outcome.daysLate);
  return PUNCTUALITY_SCALES[scale].find(([maxDaysLate]) => late <= maxDaysLate)![1];
}

export function classFor(score: number): PaymentClassInfo {
  return PAYMENT_CLASSES.find((info) => score >= info.minScore) ?? PAYMENT_CLASSES[PAYMENT_CLASSES.length - 1];
}

export function classInfo(letter: PaymentClass): PaymentClassInfo {
  return PAYMENT_CLASSES.find((info) => info.letter === letter) ?? PAYMENT_CLASSES[PAYMENT_CLASSES.length - 1];
}

/** `A` é melhor que `E`: posição na escala, para comparar e ordenar. */
export function classRank(letter: PaymentClass): number {
  return PAYMENT_CLASS_LETTERS.indexOf(letter);
}

export type PaymentTrend = 'up' | 'flat' | 'down' | 'unknown';

/**
 * Melhorou ou piorou: a letra de hoje contra a de há `TREND_DAYS`. Compara-se a
 * letra e não os pontos, porque é a letra que muda a decisão de quem cobra.
 * `unknown` enquanto uma das duas datas não tiver histórico bastante.
 */
export function trendFor(
  invoices: InvoiceFact[],
  asOf: string,
  rules: Partial<ScoreRules> = {},
  backDays: number = TREND_DAYS
): PaymentTrend {
  const now = scoreClient(invoices, asOf, rules);
  const at = dayStartUtc(asOf);
  if (now.letter === null || at === null) return 'unknown';
  const before = scoreClient(
    invoices, new Date(at - backDays * 86_400_000).toISOString().slice(0, 10), rules
  );
  if (before.letter === null) return 'unknown';
  const moved = classRank(before.letter) - classRank(now.letter);
  if (moved > 0) return 'up';
  if (moved < 0) return 'down';
  return 'flat';
}
