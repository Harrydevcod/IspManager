import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/browser';
import type { ColumnMapping, ExistingHints, ParsedRow, PreviewRow, TargetField } from './types';
import { EMPTY_MAPPING, TARGET_HINTS } from './types';

/** Auto-detect mapping from column headers to target fields, using TARGET_HINTS regex matrix. */
export function detectMapping(headers: string[]): ColumnMapping {
  const map: ColumnMapping = { ...EMPTY_MAPPING };
  for (const target of Object.keys(TARGET_HINTS) as TargetField[]) {
    const hints = TARGET_HINTS[target];
    const found = headers.find((header) => {
      const normalized = header.trim();
      return hints.some((rx) => rx.test(normalized));
    });
    if (found) map[target] = found;
  }
  return map;
}

/** Build the preview rows: apply mapping, validate, mark conflicts with existing data. */
export function buildPreview(
  rows: ParsedRow[],
  mapping: ColumnMapping,
  existing: ExistingHints
): PreviewRow[] {
  const seenCodes = new Set<string>();
  const seenNifs = new Set<string>();
  const seenPhones = new Set<string>();

  return rows.map((raw, index) => {
    const values: Partial<Record<TargetField, string>> = {};
    for (const target of Object.keys(mapping) as TargetField[]) {
      const source = mapping[target];
      if (!source) continue;
      const value = (raw[source] ?? '').toString().trim();
      if (value) values[target] = value;
    }

    const errors: string[] = [];
    if (!values.fullName) errors.push('Nome em falta');
    if (values.nif && !/^\d{9}$/.test(values.nif)) errors.push('NIF deve ter 9 digitos');
    if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
      errors.push('Email invalido');
    }

    let conflict: PreviewRow['conflict'] = null;
    if (values.clientCode) {
      if (existing.codes.has(values.clientCode) || seenCodes.has(values.clientCode)) {
        conflict = 'clientCode';
      } else {
        seenCodes.add(values.clientCode);
      }
    }
    if (!conflict && values.nif) {
      if (existing.nifs.has(values.nif) || seenNifs.has(values.nif)) {
        conflict = 'nif';
      } else {
        seenNifs.add(values.nif);
      }
    }
    if (!conflict && values.phone) {
      if (existing.phones.has(values.phone) || seenPhones.has(values.phone)) {
        conflict = 'phone';
      } else {
        seenPhones.add(values.phone);
      }
    }

    return { index, raw, values, errors, conflict };
  });
}

/** Parse a user-picked file. Routes to readXlsxFile for .xlsx/.xls; Papa.parse for CSV. */
export async function parseFile(file: File): Promise<{ headers: string[]; rows: ParsedRow[] }> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const sheet = (await readXlsxFile(file)) as unknown as unknown[][];
    if (sheet.length === 0) return { headers: [], rows: [] };
    const headerRow = sheet[0] as unknown[];
    const headers = headerRow.map((value) => String(value ?? '').trim());
    const rows: ParsedRow[] = (sheet.slice(1) as unknown[][])
      .filter((row) => row.some((cell) => cell !== null && cell !== ''))
      .map((row) => {
        const out: ParsedRow = {};
        headers.forEach((header, i) => {
          const cell = row[i];
          out[header] = cell === null || cell === undefined ? '' : String(cell).trim();
        });
        return out;
      });
    return { headers, rows };
  }

  return new Promise((resolve, reject) => {
    Papa.parse<ParsedRow>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.trim(),
      transform: (value) => (typeof value === 'string' ? value.trim() : value),
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        resolve({ headers, rows: results.data });
      },
      error: (err) => reject(err instanceof Error ? err : new Error(String(err)))
    });
  });
}
