const UNIT: Record<string, number> = { w: 604_800, d: 86_400, h: 3600, m: 60, s: 1, ms: 0 };

/** "1w2d3h4m5s" em segundos; null se o router escrever outra coisa. Os milissegundos ("5s300ms") ignoram-se. */
export function uptimeSeconds(uptime: string | null): number | null {
  if (!uptime) return null;
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of uptime.matchAll(/(\d+)(ms|[wdhms])/g)) {
    total += Number(amount) * UNIT[unit];
    matched = true;
  }
  return matched ? total : null;
}
