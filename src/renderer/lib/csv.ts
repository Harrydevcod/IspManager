/**
 * Exportação para CSV, com o endurecimento contra injeção de fórmulas no sítio
 * onde os dois exportadores o encontram.
 *
 * Estava inline nos Relatórios; a Descoberta é o segundo consumidor, e duas
 * cópias deste `csvValue` é como se perde uma delas quando o Excel mudar de
 * ideias sobre o que é uma fórmula.
 */

/**
 * Uma célula que comece por `=`, `+`, `-`, `@`, tabulação ou CR é interpretada
 * como fórmula pelo Excel e pelo Sheets (CWE-1236). O prefixo de plica força-a
 * a ser texto literal.
 */
export function csvValue(value: string | number | null | undefined): string {
  const raw = String(value ?? '');
  const text = (/^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw).replace(/"/g, '""');
  return `"${text}"`;
}

/** Separador `;` — é o que o Excel em português espera sem perguntar nada. */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvValue).join(';')).join('\n');
}

export function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
