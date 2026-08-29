/**
 * Coerência cronológica das datas do ciclo de equipamento num serviço.
 *
 * O equipamento instala-se hoje e regista-se amanhã. Enquanto a data era
 * `date('now')`, o que ficava gravado era o dia do registo — vê-se na base, com
 * dezenas de atribuições todas no dia do carregamento inicial. Com a data a vir
 * do formulário, alguém a vai escrever errada, e é isto que trava o disparate:
 *
 *  - instalação: não pode ser futura, nem anterior à ativação do serviço;
 *  - devolução ou troca: não pode ser futura, nem anterior à instalação.
 *
 * Funções puras, no molde de [[validatePaymentDates]] — recebem as datas e a
 * referência de "hoje", devolvem `errors` (bloqueiam) e `warnings` (a
 * confirmar). Não tocam na base: o chamador decide onde as aplicar. As
 * mensagens citam as datas em dia-mês-ano, como o resto da aplicação.
 */

import { dayStartUtc, labelDay, todayStartUtc } from './date';

export type AssignmentDates = {
  /** Quando o equipamento foi instalado (`AAAA-MM-DD`). */
  startDate?: string | null;
  /** Quando saiu — devolução ou troca (`AAAA-MM-DD`). */
  endDate?: string | null;
  /** Ativação do serviço, quando conhecida: nada se instala antes dela. */
  activationDate?: string | null;
};

export type AssignmentDatesOptions = {
  /** Referência de "agora". Default: `new Date()`. */
  today?: Date;
  /** Tolerância (dias) para datas no futuro — ajustes de fuso. Default: 1. */
  futureToleranceDays?: number;
};

export type AssignmentDatesValidation = {
  errors: string[];
  warnings: string[];
};

const DAY_MS = 86_400_000;

export function validateAssignmentDates(
  dates: AssignmentDates,
  options: AssignmentDatesOptions = {}
): AssignmentDatesValidation {
  const { today = new Date(), futureToleranceDays = 1 } = options;

  const errors: string[] = [];
  const warnings: string[] = [];

  const start = dates.startDate != null ? dayStartUtc(dates.startDate) : null;
  const end = dates.endDate != null ? dayStartUtc(dates.endDate) : null;
  const activation = dates.activationDate != null ? dayStartUtc(dates.activationDate) : null;

  // Uma data que existe mas não se lê é erro de quem a escreveu, não silêncio:
  // deixá-la passar gravaria texto onde devia estar um dia.
  if (dates.startDate != null && dates.startDate !== '' && start == null) {
    errors.push('Data de instalação inválida.');
  }
  if (dates.endDate != null && dates.endDate !== '' && end == null) {
    errors.push('Data de saída inválida.');
  }

  const todayStart = todayStartUtc(today);
  const futureLimit = todayStart + futureToleranceDays * DAY_MS;

  if (start != null && start > futureLimit) {
    errors.push(`Data de instalação ${labelDay(dates.startDate)} está no futuro.`);
  }
  if (end != null && end > futureLimit) {
    errors.push(`Data de saída ${labelDay(dates.endDate)} está no futuro.`);
  }

  if (start != null && end != null && end < start) {
    errors.push(
      `Data de saída ${labelDay(dates.endDate)} é anterior à instalação ${labelDay(dates.startDate)}.`
    );
  }

  if (start != null && activation != null && start < activation) {
    errors.push(
      `Data de instalação ${labelDay(dates.startDate)} é anterior à ativação do serviço ${labelDay(dates.activationDate)}.`
    );
  }

  return { errors, warnings };
}

/** Hoje em `AAAA-MM-DD`, o valor por omissão de todos estes campos. */
export function todayIso(now: Date = new Date()): string {
  return new Date(todayStartUtc(now)).toISOString().slice(0, 10);
}

export type FactMoment = {
  /** O dia, para as colunas de data (`start_date`, `end_date`, `installed_on`). */
  day: string;
  /** O instante, para as colunas de timestamp (movimentos de stock, eventos). */
  at: string;
};

/**
 * O momento do facto, nos dois formatos que o SQLite guarda.
 *
 * Sem data é agora, no mesmo formato UTC que `datetime('now')` escreve. Com
 * data, o instante é o meio-dia desse dia: um dia passado precisa de hora para
 * caber num timestamp, e ao meio-dia nenhum fuso o empurra para a véspera ou
 * para o dia seguinte.
 */
export function factMoment(isoDay?: string | null, now: Date = new Date()): FactMoment {
  const day = (isoDay ?? '').trim().slice(0, 10);
  if (!day || dayStartUtc(day) == null) {
    return { day: todayIso(now), at: now.toISOString().replace('T', ' ').slice(0, 19) };
  }
  return { day, at: `${day} 12:00:00` };
}
