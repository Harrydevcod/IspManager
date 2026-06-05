function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatPtDate(value: string | null | undefined): string {
  const date = parseIsoDate(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
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
  }).format(date);
}
