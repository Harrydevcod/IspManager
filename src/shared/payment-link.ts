/**
 * Variável `{link}` dos avisos: o link de pagamento online de uma fatura.
 *
 * Expande para a frase inteira, não só para o URL: uma fatura sem link fica sem
 * frase nenhuma, em vez de um "Pague aqui:" pendurado. O espaço antes da
 * variável vai com ela, e o fim da mensagem é aparado.
 */
export function expandPaymentLink(template: string, url: string | null | undefined): string {
  return template
    .replace(/([ \t]*)\{link\}/gi, (_match, space: string) => (url ? `${space}Pague online: ${url}` : ''))
    .trimEnd();
}
