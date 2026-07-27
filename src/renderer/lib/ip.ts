const OCTET = /^\d{1,3}$/;

const DEFAULT_PREFIX = '192.168.1.';

/**
 * Prefixo /24 mais usado nos equipamentos já instalados, para sugerir o início do
 * IP em vez de o obrigar a escrever inteiro 42 vezes. É só uma sugestão: o campo
 * continua livre para outra faixa ou classe.
 *
 * Aceita as strings de `deviceIps` tal como vêm da API (IPs separados por vírgula)
 * e ignora entradas malformadas — um `192.168.1.X` legado ainda dá um bom prefixo.
 */
export function suggestIpPrefix(entries: Array<string | null | undefined>): string {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    for (const candidate of (entry || '').split(',')) {
      const parts = candidate.trim().split('.');
      if (parts.length !== 4) {
        continue;
      }
      const [a, b, c] = parts;
      if (![a, b, c].every((part) => OCTET.test(part) && Number(part) <= 255)) {
        continue;
      }
      const prefix = `${a}.${b}.${c}.`;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  let best = DEFAULT_PREFIX;
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix;
      bestCount = count;
    }
  }
  return best;
}
