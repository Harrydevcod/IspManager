import { useCallback, useState } from 'react';

/**
 * Parte um `grid-template-columns` nas suas faixas de topo. Os espaços dentro de
 * parênteses (`minmax(0, 1fr)`) não partem nada.
 */
export function splitTracks(template: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of template.trim()) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) tracks.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) tracks.push(current);
  return tracks;
}

/**
 * As colunas que ficam e a grelha com as faixas delas. Se o número de faixas não
 * bater com o de colunas (`repeat(...)`, por exemplo), a grelha não se toca:
 * esconder deixa de ser seguro e a tabela fica como estava.
 */
export function visibleColumns<C extends { header: string }>(
  columns: C[],
  template: string,
  hidden: ReadonlySet<string> | undefined
): { columns: C[]; gridTemplateColumns: string } {
  if (!hidden?.size) return { columns, gridTemplateColumns: template };
  const tracks = splitTracks(template);
  if (tracks.length !== columns.length) return { columns, gridTemplateColumns: template };
  const keep = columns.map((column) => !hidden.has(column.header));
  return {
    columns: columns.filter((_, index) => keep[index]),
    gridTemplateColumns: tracks.filter((_, index) => keep[index]).join(' ')
  };
}

function readHidden(
  storageKey: string,
  headers: readonly string[],
  defaultHidden: readonly string[]
): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    // Nunca escolheu neste posto: vale o que a tabela propõe.
    const stored: unknown = raw === null ? defaultHidden : JSON.parse(raw);
    if (!Array.isArray(stored)) return new Set();
    // Uma coluna renomeada ou retirada não fica escondida para sempre.
    const hidden = new Set(stored.filter((header): header is string => headers.includes(header)));
    return hidden.size >= headers.length ? new Set() : hidden;
  } catch {
    return new Set(defaultHidden.filter((header) => headers.includes(header)));
  }
}

function writeHidden(storageKey: string, hidden: ReadonlySet<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...hidden]));
  } catch {
    /* localStorage indisponivel — preferencia nao persiste, sem impacto funcional */
  }
}

/**
 * Colunas escondidas de uma tabela, guardadas no posto: cada PC tem o seu ecrã,
 * e o que não cabe num portátil cabe num monitor.
 */
export function useColumnVisibility(
  storageKey: string,
  headers: readonly string[],
  defaultHidden: readonly string[] = []
) {
  const [hidden, setHidden] = useState(() => readHidden(storageKey, headers, defaultHidden));

  const toggle = useCallback((header: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(header)) next.delete(header);
      // A última coluna visível fica: uma tabela sem colunas não se lê.
      else if (headers.length - next.size > 1) next.add(header);
      else return current;
      writeHidden(storageKey, next);
      return next;
    });
  }, [storageKey, headers]);

  const reset = useCallback(() => {
    const next = new Set<string>();
    writeHidden(storageKey, next);
    setHidden(next);
  }, [storageKey]);

  return { hidden, toggle, reset };
}
