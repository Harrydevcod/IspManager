/**
 * O NIB é para copiar para o homebanking. Guardado com os espaços com que foi
 * escrito, cola-se mal e leva a transferências para o sítio errado — por isso
 * vive numa forma só: dígitos, sem espaços, pontos nem hífenes.
 *
 * Aceita o que as pessoas escrevem e colam do extrato; devolve o canónico, ou
 * `null` quando não sobra dígito nenhum.
 */
export function canonicalNib(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits || null;
}
