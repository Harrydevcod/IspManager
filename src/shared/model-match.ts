/**
 * As referências que identificam um aparelho: blocos com letras **e** números,
 * como `CPE710`, `WR841N` ou `RB951Ui`.
 *
 * É este o pedaço que sobrevive a toda a decoração à volta. O catálogo escreve
 * `TP-Link CPE710` e o aparelho responde `CPE710(EU) v2.0`: o que os liga é a
 * referência, não a marca (que se repete em todo o parque) nem o número de
 * versão (`v2`, `2.0` — curtos de mais para distinguir seja o que for, daí o
 * mínimo de quatro caracteres).
 */
function modelTokens(value: string): Set<string> {
  const tokens = value.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  return new Set(tokens.filter((token) => token.length >= 4 && /\d/.test(token) && /[A-Z]/.test(token)));
}

/**
 * Dois nomes de modelo são o mesmo aparelho?
 *
 * Frouxo de propósito. Isto só existe para levantar um aviso, e um aviso só
 * vale enquanto for raro: exigir igualdade exata pintava de laranja a tabela
 * inteira e ensinava quem a usa a ignorá-la. Na dúvida, não alarma.
 */
export function sameModel(a: string, b: string): boolean {
  const [left, right] = [modelTokens(a), modelTokens(b)];
  if (left.size > 0 && right.size > 0) return [...left].some((token) => right.has(token));

  // Um dos lados não tem referência nenhuma para comparar — resta ver se um
  // texto encaixa no outro.
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const [x, y] = [key(a), key(b)];
  if (!x || !y) return true;
  return x.includes(y) || y.includes(x);
}
