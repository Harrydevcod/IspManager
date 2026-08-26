/**
 * O MAC é a identidade de fábrica de um equipamento — único por definição, e o
 * que o técnico consegue ler quando a etiqueta da série já não se lê. Desde que
 * passou a valer como identidade no mapa, vale a pena ser guardado numa forma
 * só: `AA:BB:CC:DD:EE:FF`.
 *
 * Aceita o que as pessoas e os equipamentos escrevem — dois-pontos, hífenes,
 * pontos (formato Cisco) ou nada — e devolve sempre o canónico.
 */
const MAC_CANONICAL = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

export const MAC_FORMAT_ERROR = 'MAC invalido. Use o formato AA:BB:CC:DD:EE:FF';

/**
 * Vazio → `null`. O que parece um MAC volta canónico; o que não parece volta
 * como veio (trimado), para quem valida poder recusá-lo com a mensagem certa em
 * vez de o guardar em silêncio.
 */
export function normalizeMacAddress(raw: string | null | undefined): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const hex = trimmed.replace(/[:.-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) return trimmed;
  return (hex.match(/.{2}/g) as string[]).join(':');
}

export function isMacAddress(value: string): boolean {
  return MAC_CANONICAL.test(value);
}
