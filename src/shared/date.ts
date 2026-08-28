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

// --- Comparação cronológica ---------------------------------------------
// Datas-só-dia comparam-se à meia-noite UTC: sem hora, o fuso só introduz
// erros de um dia. Vieram de `payment-dates.ts`, onde eram privadas, quando a
// validação das datas de atribuição passou a precisar exactamente das mesmas.

/** `AAAA-MM-DD` → timestamp UTC à meia-noite, ou `null` se inválida/inexistente. */
export function dayStartUtc(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const t = Date.UTC(year, month - 1, day);
  const dt = new Date(t);
  // Rejeita datas impossíveis (ex.: 2026-02-31 → normalizaria para Março).
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return t;
}

export function todayStartUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** `AAAA-MM-DD` → `DD-MM-AAAA`; devolve `-` se não houver data. */
export function labelDay(iso: string | null | undefined): string {
  if (!iso) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '-';
}
