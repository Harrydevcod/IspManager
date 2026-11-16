/**
 * O que uma fatura ou recibo cobra, em texto para o cliente: o período por extenso e a lista dos
 * serviços. Serve as mensagens (WhatsApp e SMS) e a área do cliente.
 */

export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** `a`, `a e b`, `a, b e c`. */
export function joinPt(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

/** Uma fatura e o que a situa no tempo: a competência e, para as que não são mensais, a data dela. */
export type PeriodSource = { referenceMonth: string; invoiceDate?: string | null; dueDate?: string | null };

type Period = { year: number; month: number | null };

/**
 * `YYYY-MM` é o mês; `AV-AAAA-MM` (anuidade audiovisual) é o ano; instalação e faturas avulsas
 * não têm competência mensal e ficam no mês em que foram emitidas.
 */
function periodOf(source: PeriodSource): Period | null {
  const annual = /^AV-(\d{4})-\d{2}$/.exec(source.referenceMonth);
  if (annual) return { year: Number(annual[1]), month: null };
  const monthly = /^(\d{4})-(\d{2})$/.exec(source.referenceMonth);
  const date = monthly ? null : /^(\d{4})-(\d{2})/.exec(source.invoiceDate || source.dueDate || '');
  const match = monthly ?? date;
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
}

/**
 * `outubro de 2026`, `outubro e novembro de 2026`, `dezembro de 2025 e janeiro de 2026`,
 * `ano de 2026`. Vazio quando nenhuma fatura tem período conhecido.
 */
export function describePeriods(sources: PeriodSource[]): string {
  const years = new Map<number, { annual: boolean; months: Set<number> }>();
  for (const period of sources.map(periodOf)) {
    if (!period) continue;
    const entry = years.get(period.year) ?? { annual: false, months: new Set<number>() };
    if (period.month === null) entry.annual = true;
    else entry.months.add(period.month);
    years.set(period.year, entry);
  }
  const parts: string[] = [];
  for (const [year, entry] of [...years].sort(([a], [b]) => a - b)) {
    const months = [...entry.months].sort((a, b) => a - b).map((month) => MONTHS[month - 1]);
    if (months.length) parts.push(`${joinPt(months)} de ${year}`);
    if (entry.annual) parts.push(`ano de ${year}`);
  }
  return joinPt(parts);
}

/** Uma linha de fatura e o plano do serviço a que pertence. */
export type ServiceLineSource = { kind: string; description: string; planName?: string | null };

/**
 * `Internet Standard`, `Internet Standard e Distribuição de Conteúdos Audiovisuais`, `instalação`,
 * `aluguer de equipamento`, ou o nome do artigo avulso. Sem repetidos e pela ordem da fatura.
 */
export function describeServiceLines(lines: ServiceLineSource[]): string {
  const names: string[] = [];
  for (const line of lines) {
    const name = line.kind === 'internet' ? (line.planName ? `Internet ${line.planName}` : 'Internet')
      : line.kind === 'instalacao' ? 'instalação'
        : line.kind === 'aluguer' ? 'aluguer de equipamento'
          : line.description.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return joinPt(names);
}

/** Só os caracteres do alfabeto GSM-7: um "ã" ou um "ç" passa o SMS para 70 caracteres por parte. */
export function toGsm7(text: string): string {
  return text.replace(/[áâã]/g, 'a').replace(/[ÁÂÃ]/g, 'A').replace(/ç/g, 'c').replace(/ê/g, 'e').replace(/Ê/g, 'E')
    .replace(/í/g, 'i').replace(/Í/g, 'I').replace(/[óôõ]/g, 'o').replace(/[ÓÔÕ]/g, 'O').replace(/ú/g, 'u').replace(/Ú/g, 'U');
}
