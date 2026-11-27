/** Agregações do consumo diário para a aba Consumo. Puras: o dia já vem no dia de Cabo Verde. */

export type UsageDay = { day: string; downBytes: number; upBytes: number };
export type UsagePeriod = { key: string; start: string; end: string; downBytes: number; upBytes: number; days: number };

function group(daily: UsageDay[], keyOf: (day: string) => string): UsagePeriod[] {
  const map = new Map<string, UsagePeriod>();
  for (const d of daily) {
    const key = keyOf(d.day);
    const period = map.get(key) ?? { key, start: d.day, end: d.day, downBytes: 0, upBytes: 0, days: 0 };
    period.downBytes += d.downBytes;
    period.upBytes += d.upBytes;
    period.days += 1;
    if (d.day < period.start) period.start = d.day;
    if (d.day > period.end) period.end = d.day;
    map.set(key, period);
  }
  // Do mais recente para o mais antigo, como os ciclos.
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

export const groupByMonth = (daily: UsageDay[]) => group(daily, (day) => day.slice(0, 7));
export const groupByYear = (daily: UsageDay[]) => group(daily, (day) => day.slice(0, 4));

/** Média por dia medido: com o ISPM fechado há dias sem registo, que não contam como zero. */
export const dailyAverage = (p: { downBytes: number; upBytes: number; days: number }) => (p.days > 0 ? (p.downBytes + p.upBytes) / p.days : 0);

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = domingo

export type UsageFigures = {
  avgDaily: number;
  peak: { day: string; bytes: number } | null;
  weekdayAvg: number | null;
  weekendAvg: number | null;
  /** Último ciclo completo face à média dos 3 anteriores, em %; null sem histórico suficiente. */
  trendPercent: number | null;
};

/** Números do perfil sobre os últimos `windowDays` dias da série (90 por omissão). */
export function usageFigures(daily: UsageDay[], completedCycleTotals: number[], today: string, windowDays = 90): UsageFigures {
  const from = new Date(`${today}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (windowDays - 1));
  const since = from.toISOString().slice(0, 10);
  const recent = daily.filter((d) => d.day >= since && d.day <= today);
  const total = (d: UsageDay) => d.downBytes + d.upBytes;
  const avg = (days: UsageDay[]) => (days.length ? days.reduce((sum, d) => sum + total(d), 0) / days.length : null);
  const peak = recent.reduce<UsageDay | null>((best, d) => (!best || total(d) > total(best) ? d : best), null);
  const [last, ...before] = completedCycleTotals;
  const base = before.slice(0, 3);
  const baseAvg = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;
  return {
    avgDaily: avg(recent) ?? 0,
    peak: peak ? { day: peak.day, bytes: total(peak) } : null,
    weekdayAvg: avg(recent.filter((d) => weekday(d.day) >= 1 && weekday(d.day) <= 5)),
    weekendAvg: avg(recent.filter((d) => weekday(d.day) === 0 || weekday(d.day) === 6)),
    trendPercent: last !== undefined && baseAvg > 0 ? Math.round(((last - baseAvg) / baseAvg) * 100) : null
  };
}
