export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/**
 * Diferenças por linhas (subsequência comum mais longa).
 * ponytail: tabela O(n·m) em memória — sobra para uma exportação de router (centenas de
 * linhas); trocar por Myers se um dia comparar ficheiros de dezenas de milhares.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'same', text: a[i] }); i++; j++; }
    // No empate sai primeiro o que foi removido, como em qualquer diff.
    else if (j < b.length && (i === a.length || lcs[i][j + 1] > lcs[i + 1][j])) lines.push({ kind: 'added', text: b[j++] });
    else lines.push({ kind: 'removed', text: a[i++] });
  }
  return lines;
}
