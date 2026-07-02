/**
 * Validação de coerência cronológica das datas de uma fatura/pagamento.
 *
 * Datas envolvidas:
 *  - dataReferencia: período a que o documento se reporta. Aceita mês
 *    (`AAAA-MM`, ex.: `2026-07`), dia (`AAAA-MM-DD`) ou o formato audiovisual
 *    (`AV-AAAA-MM`). Um mês é tratado como o seu primeiro dia para comparações.
 *  - dataEmissao: data de criação do documento (`AAAA-MM-DD`).
 *  - dataVencimento: data limite de pagamento (`AAAA-MM-DD`, opcional).
 *  - dataPagamento: data em que o pagamento foi efetuado (`AAAA-MM-DD`, opcional).
 *
 * Função pura — recebe as datas e a referência de "hoje", devolve `errors`
 * (bloqueiam a gravação) e `warnings` (situações atípicas a confirmar). Não
 * toca na base de dados: o chamador decide onde a aplicar. As mensagens citam
 * as datas em formato dia-mês-ano (DD-MM-AAAA; mês → MM-AAAA).
 */

export type PaymentDates = {
  dataReferencia?: string | null;
  dataEmissao?: string | null;
  dataVencimento?: string | null;
  dataPagamento?: string | null;
};

export type PaymentDatesOptions = {
  /** Referência de "agora". Default: `new Date()`. */
  today?: Date;
  /** Tolerância (dias) para a emissão no futuro — ajustes de fuso. Default: 1. */
  emissaoFutureToleranceDays?: number;
  /** Margem (dias) para a referência no futuro — previsão de serviço. Default: 30. */
  referenciaFutureMarginDays?: number;
};

export type PaymentDatesValidation = {
  errors: string[];
  warnings: string[];
};

const DAY_MS = 86_400_000;

/** `AAAA-MM-DD` → timestamp UTC à meia-noite, ou `null` se inválida/inexistente. */
function dayStart(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const t = Date.UTC(year, month - 1, day);
  const dt = new Date(t);
  // Rejeita datas impossíveis (ex.: 2026-02-31 → normalizaria para Março).
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return t;
}

/** Referência → timestamp. Dia exato se `AAAA-MM-DD`; senão 1.º dia do mês. */
function referenceDayStart(ref: string): number | null {
  const exact = dayStart(ref);
  if (exact != null) return exact;
  const m = /(\d{4})-(\d{2})/.exec(ref); // apanha `2026-07` e `AV-2026-07`
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
}

function todayStartUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** `AAAA-MM-DD` → `DD-MM-AAAA`; devolve `-` se não houver data. */
function labelDay(iso: string | null | undefined): string {
  if (!iso) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '-';
}

/** Rótulo da referência: `DD-MM-AAAA` para dia exato, `MM-AAAA` para mês. */
function labelReference(ref: string | null | undefined): string {
  if (!ref) return '-';
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(ref);
  if (full) return `${full[3]}-${full[2]}-${full[1]}`;
  const ym = /(\d{4})-(\d{2})/.exec(ref); // `2026-07` ou `AV-2026-07`
  return ym ? `${ym[2]}-${ym[1]}` : ref;
}

export function validatePaymentDates(
  dates: PaymentDates,
  options: PaymentDatesOptions = {}
): PaymentDatesValidation {
  const {
    today = new Date(),
    emissaoFutureToleranceDays = 1,
    referenciaFutureMarginDays = 30
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];

  const ref = dates.dataReferencia != null ? referenceDayStart(dates.dataReferencia) : null;
  const emi = dates.dataEmissao != null ? dayStart(dates.dataEmissao) : null;
  const ven = dates.dataVencimento != null ? dayStart(dates.dataVencimento) : null;
  const pag = dates.dataPagamento != null ? dayStart(dates.dataPagamento) : null;

  const todayStart = todayStartUtc(today);
  const emiLabel = () => labelDay(dates.dataEmissao);
  const refLabel = () => labelReference(dates.dataReferencia);

  // 1. Referência não pode ser posterior à emissão.
  if (ref != null && emi != null && ref > emi) {
    errors.push(`A data de referência (${refLabel()}) não pode ser posterior à data de emissão (${emiLabel()}).`);
  }
  // 2. Pagamento (se existir) não pode ser anterior à emissão.
  if (emi != null && pag != null && pag < emi) {
    errors.push(`A data de pagamento (${labelDay(dates.dataPagamento)}) não pode ser anterior à data de emissão (${emiLabel()}).`);
  }
  // 3. Vencimento (se existir) não pode ser anterior à emissão.
  if (emi != null && ven != null && ven < emi) {
    errors.push(`A data de vencimento (${labelDay(dates.dataVencimento)}) não pode ser anterior à data de emissão (${emiLabel()}).`);
  }
  // 4. Vencimento anterior à referência → atípico (aviso, pedir confirmação).
  if (ref != null && ven != null && ven < ref) {
    warnings.push(`A data de vencimento (${labelDay(dates.dataVencimento)}) é anterior ao período de referência (${refLabel()}) — situação atípica, confirme.`);
  }
  // 5. Emissão não pode ser futura (além da tolerância).
  if (emi != null && emi > todayStart + emissaoFutureToleranceDays * DAY_MS) {
    errors.push(`A data de emissão (${emiLabel()}) não pode ser uma data futura.`);
  }
  // 6. Referência não pode exceder hoje + margem (previsão de serviço).
  if (ref != null && ref > todayStart + referenciaFutureMarginDays * DAY_MS) {
    errors.push(`A data de referência (${refLabel()}) não pode exceder ${referenciaFutureMarginDays} dias no futuro.`);
  }

  return { errors, warnings };
}
