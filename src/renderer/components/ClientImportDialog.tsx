import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/browser';
import { CheckCircle2, Download, FileSpreadsheet, FileText, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Dialog } from './Dialog';
import { useToast } from './Toaster';
import { authFetch } from '../lib/auth';

type TargetField =
  | 'clientCode'
  | 'nif'
  | 'fullName'
  | 'phone'
  | 'email'
  | 'address'
  | 'island'
  | 'zone';

const TARGET_LABEL: Record<TargetField, string> = {
  clientCode: 'Código',
  nif: 'NIF',
  fullName: 'Nome',
  phone: 'Telefone',
  email: 'Email',
  address: 'Morada',
  island: 'Ilha',
  zone: 'Zona'
};

const TARGET_HINTS: Record<TargetField, RegExp[]> = {
  clientCode: [/^(codigo|c[oó]digo|code|client[\s_-]?code|cliente[\s_-]?id|n[uú]mero|nº|n\.|numero)$/i],
  nif: [/^(nif|fiscal|tax(\s?id)?|cif)$/i],
  fullName: [/^(nome|name|cliente|fullname|full[\s_-]?name|nome[\s_-]?completo|razao[\s_-]?social)$/i],
  phone: [/^(telefone|telem[oó]vel|phone|tel|contacto|m[oó]vel|mobile|whatsapp)$/i],
  email: [/^(e?[\s_-]?mail|correio)$/i],
  address: [/^(morada|endere[cç]o|address|rua)$/i],
  island: [/^(ilha|island)$/i],
  zone: [/^(zona|bairro|zone|localidade|local)$/i]
};

const REQUIRED: TargetField[] = ['fullName'];

type ParsedRow = Record<string, string>;

type PreviewRow = {
  index: number;
  raw: ParsedRow;
  values: Partial<Record<TargetField, string>>;
  errors: string[];
  conflict: 'clientCode' | 'nif' | 'phone' | null;
};

type BulkResult = {
  summary: { received: number; inserted: number; skipped: number; errors: number };
  inserted: Array<{ index: number; clientCode: string }>;
  skipped: Array<{ index: number; reason: string; value?: string }>;
  errors: Array<{ index: number; reason: string; detail?: string }>;
};

type ExistingHints = {
  codes: Set<string>;
  nifs: Set<string>;
  phones: Set<string>;
};

function detectMapping(headers: string[]): Record<TargetField, string | ''> {
  const map: Record<TargetField, string | ''> = {
    clientCode: '',
    nif: '',
    fullName: '',
    phone: '',
    email: '',
    address: '',
    island: '',
    zone: ''
  };
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

function buildPreview(
  rows: ParsedRow[],
  mapping: Record<TargetField, string | ''>,
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

async function parseFile(file: File): Promise<{ headers: string[]; rows: ParsedRow[] }> {
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

export type ClientImportDialogProps = {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
};

export function ClientImportDialog({ open, onClose, onCompleted }: ClientImportDialogProps) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<ParsedRow[]>([]);
  const [mapping, setMapping] = useState<Record<TargetField, string | ''>>({
    clientCode: '',
    nif: '',
    fullName: '',
    phone: '',
    email: '',
    address: '',
    island: '',
    zone: ''
  });
  const [existing, setExisting] = useState<ExistingHints>({
    codes: new Set(),
    nifs: new Set(),
    phones: new Set()
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [dragHover, setDragHover] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function downloadTemplate() {
    if (downloadingTemplate) return;
    setDownloadingTemplate(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/clients/import-template.xlsx');
      if (!response.ok) {
        toast('Não foi possível descarregar o template.', 'error');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'clientes-template.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast('Falha de rede ao descarregar o template.', 'error');
    } finally {
      setDownloadingTemplate(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    authFetch('http://127.0.0.1:3001/api/clients')
      .then((res) => res.json() as Promise<Array<{ clientCode: string; nif: string | null; phone: string | null }>>)
      .then((rows) => {
        setExisting({
          codes: new Set(rows.map((r) => r.clientCode)),
          nifs: new Set(rows.map((r) => r.nif).filter((v): v is string => !!v)),
          phones: new Set(rows.map((r) => r.phone).filter((v): v is string => !!v))
        });
      })
      .catch(() => setExisting({ codes: new Set(), nifs: new Set(), phones: new Set() }));
  }, [open]);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setHeaders([]);
      setRawRows([]);
      setResult(null);
      setParseError(null);
      setParsing(false);
      setSubmitting(false);
    }
  }, [open]);

  async function ingest(nextFile: File) {
    setFile(nextFile);
    setParsing(true);
    setParseError(null);
    setResult(null);
    try {
      const { headers: nextHeaders, rows: nextRows } = await parseFile(nextFile);
      if (nextRows.length === 0) {
        setParseError('Ficheiro sem linhas com dados.');
        setHeaders([]);
        setRawRows([]);
        return;
      }
      setHeaders(nextHeaders);
      setRawRows(nextRows);
      setMapping(detectMapping(nextHeaders));
    } catch (err) {
      setHeaders([]);
      setRawRows([]);
      setParseError(err instanceof Error ? err.message : 'Falha ao ler ficheiro.');
    } finally {
      setParsing(false);
    }
  }

  function onFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    if (next) void ingest(next);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragHover(false);
    const next = event.dataTransfer.files?.[0];
    if (next) void ingest(next);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragHover(true);
  }

  function onDragLeave() {
    setDragHover(false);
  }

  const preview = useMemo(() => buildPreview(rawRows, mapping, existing), [rawRows, mapping, existing]);
  const counters = useMemo(() => {
    let ok = 0;
    let conflict = 0;
    let error = 0;
    for (const row of preview) {
      if (row.errors.length > 0) error += 1;
      else if (row.conflict) conflict += 1;
      else ok += 1;
    }
    return { ok, conflict, error, total: preview.length };
  }, [preview]);

  const missingRequired = REQUIRED.filter((target) => !mapping[target]);

  async function submit() {
    if (submitting) return;
    if (missingRequired.length > 0) {
      toast(`Mapeia o campo obrigatorio: ${missingRequired.map((t) => TARGET_LABEL[t]).join(', ')}`, 'error');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        rows: preview
          .filter((row) => row.errors.length === 0)
          .map((row) => row.values)
      };
      const response = await authFetch('http://127.0.0.1:3001/api/clients/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        toast(data.error || 'Importacao falhou.', 'error');
        return;
      }
      const data = (await response.json()) as BulkResult;
      setResult(data);
      toast(`${data.summary.inserted} cliente(s) importado(s).`, 'success');
      onCompleted();
    } finally {
      setSubmitting(false);
    }
  }

  const step: 'upload' | 'preview' | 'result' = result ? 'result' : rawRows.length > 0 ? 'preview' : 'upload';

  const previewSlice = preview.slice(0, 14);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Importacao"
      title="Importar clientes"
      size="lg"
      actions={
        step === 'preview' ? (
          <>
            <button type="button" onClick={onClose}>Cancelar</button>
            <button
              type="button"
              className="primary"
              onClick={submit}
              disabled={submitting || counters.ok === 0 || missingRequired.length > 0}
            >
              {submitting
                ? 'A importar...'
                : counters.ok === 0
                  ? 'Nenhuma linha valida'
                  : `Importar ${counters.ok} cliente(s)`}
            </button>
          </>
        ) : step === 'result' ? (
          <button type="button" className="primary" onClick={onClose}>Fechar</button>
        ) : (
          <button type="button" onClick={onClose}>Cancelar</button>
        )
      }
    >
      {step === 'upload' && (
        <div className="import-upload">
          <div
            className={`import-dropzone${dragHover ? ' is-hover' : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
          >
            <Upload size={28} strokeWidth={1.4} aria-hidden />
            <p className="import-dropzone-title">
              {parsing ? 'A ler ficheiro...' : 'Largar CSV ou Excel aqui'}
            </p>
            <p className="import-dropzone-hint">
              ou <strong>clica para escolher</strong> &middot; aceita .csv .xlsx .xls
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={onFilePicked}
            />
          </div>
          {parseError && <p className="import-error">{parseError}</p>}
          <div className="import-template-row">
            <button
              type="button"
              className="import-template-button"
              onClick={() => void downloadTemplate()}
              disabled={downloadingTemplate}
            >
              <Download size={14} aria-hidden />
              {downloadingTemplate ? 'A preparar...' : 'Descarregar template Excel'}
            </button>
            <span className="import-template-hint">Cabeçalhos prontos + 2 linhas de exemplo + folha de instruções.</span>
          </div>
          <details className="import-help">
            <summary>O que deve conter o ficheiro</summary>
            <p>
              Primeira linha = cabeçalhos. Colunas reconhecidas automaticamente:
              {' '}
              <em>código, NIF, nome, telefone, email, morada, ilha, zona</em>.
              Podes mapear manualmente no próximo passo. Linhas duplicadas (por código,
              NIF ou telefone) são ignoradas — o import é seguro de repetir.
            </p>
          </details>
        </div>
      )}

      {step === 'preview' && (
        <div className="import-preview">
          <header className="import-preview-head">
            <div className="import-file">
              {file && (file.name.toLowerCase().endsWith('.csv') ? (
                <FileText size={16} aria-hidden />
              ) : (
                <FileSpreadsheet size={16} aria-hidden />
              ))}
              <span>{file?.name}</span>
              <button type="button" className="import-file-reset" onClick={() => { setFile(null); setRawRows([]); }}>
                <X size={12} aria-hidden /> mudar
              </button>
            </div>
            <div className="import-counters">
              <span className="import-counter import-counter-ok">{counters.ok} importar</span>
              <span className="import-counter import-counter-conflict">{counters.conflict} duplicado</span>
              <span className="import-counter import-counter-error">{counters.error} com erro</span>
              <span className="import-counter import-counter-total">{counters.total} total</span>
            </div>
          </header>

          <section className="import-mapping" aria-label="Mapeamento de colunas">
            {(Object.keys(TARGET_LABEL) as TargetField[]).map((target) => (
              <label key={target} className={REQUIRED.includes(target) ? 'is-required' : ''}>
                <span>{TARGET_LABEL[target]}{REQUIRED.includes(target) && ' *'}</span>
                <select
                  value={mapping[target]}
                  onChange={(event) =>
                    setMapping((current) => ({ ...current, [target]: event.target.value }))
                  }
                >
                  <option value="">(nao mapeado)</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>{header}</option>
                  ))}
                </select>
              </label>
            ))}
          </section>

          <div className="import-table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Código</th>
                  <th scope="col">NIF</th>
                  <th scope="col">Nome</th>
                  <th scope="col">Telefone</th>
                </tr>
              </thead>
              <tbody>
                {previewSlice.map((row) => {
                  const statusClass = row.errors.length > 0
                    ? 'is-error'
                    : row.conflict
                      ? 'is-conflict'
                      : 'is-ok';
                  const statusLabel = row.errors.length > 0
                    ? row.errors.join(' · ')
                    : row.conflict === 'clientCode'
                      ? 'codigo ja existe'
                      : row.conflict === 'nif'
                        ? 'NIF ja existe'
                        : row.conflict === 'phone'
                          ? 'telefone ja existe'
                          : 'ok';
                  return (
                    <tr key={row.index} className={statusClass}>
                      <td>{String(row.index + 1).padStart(2, '0')}</td>
                      <td className="import-status-cell">{statusLabel}</td>
                      <td className="import-cell-code">{row.values.clientCode || <span className="muted">auto</span>}</td>
                      <td className="import-cell-code">{row.values.nif || <span className="muted">—</span>}</td>
                      <td>{row.values.fullName || <em className="muted">—</em>}</td>
                      <td>{row.values.phone || <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {preview.length > previewSlice.length && (
              <p className="import-table-more">
                + {preview.length - previewSlice.length} linhas adicionais (todas processadas).
              </p>
            )}
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div className="import-result">
          <div className="import-result-figure">
            <CheckCircle2 size={32} strokeWidth={1.4} aria-hidden />
            <strong>{result.summary.inserted}</strong>
            <span>cliente(s) importado(s)</span>
          </div>
          <dl className="import-result-grid">
            <div>
              <dt>Recebidos</dt>
              <dd>{result.summary.received}</dd>
            </div>
            <div>
              <dt>Inseridos</dt>
              <dd>{result.summary.inserted}</dd>
            </div>
            <div>
              <dt>Ignorados (duplicados)</dt>
              <dd>{result.summary.skipped}</dd>
            </div>
            <div>
              <dt>Com erro</dt>
              <dd>{result.summary.errors}</dd>
            </div>
          </dl>
          {result.errors.length > 0 && (
            <details className="import-result-detail">
              <summary>Ver erros ({result.errors.length})</summary>
              <ul>
                {result.errors.map((err, i) => (
                  <li key={i}>linha {err.index + 1}: {err.detail || err.reason}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Dialog>
  );
}
