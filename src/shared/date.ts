// Single source of truth for pt-PT date formatting, shared by backend and
// renderer. Parses date-only strings as local midnight (avoids the UTC
// off-by-one of `new Date('YYYY-MM-DD')`) and passes datetime strings through
// so timestamps keep their time component. Separador dia-mês-ano é o hífen
// (dd-mm-aaaa), não a barra pt-PT por defeito.
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const source = value.includes('T')
    ? value
    // 'AAAA-MM-DD hh:mm:ss' é o que o SQLite escreve com datetime('now'), e é
    // UTC. Sem isto o tempo caía para 00:00 — uma leitura da sonda feita às
    // 05:14 aparecia à meia-noite.
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : `${value.slice(0, 10)}T00:00:00`;
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatPtDate(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date).replace(/\//g, '-');
}

export function formatPtDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date).replace(/\//g, '-');
}

export function formatPtDayMonth(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit'
  }).format(date).replace(/\//g, '-');
}

export function formatPtMonth(value: string | null | undefined): string {
  if (!value) return '-';
  const [year, month] = value.slice(0, 7).split('-').map(Number);
  if (!year || !month) return '-';
  const date = new Date(year, month - 1, 1);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    month: '2-digit',
    year: 'numeric'
  }).format(date).replace(/\//g, '-');
}
