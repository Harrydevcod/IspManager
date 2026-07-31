import { useCallback, useEffect, useMemo, useState } from 'react';
import { authFetch } from '../../../lib/auth';
import { isKnownIsland } from '../../../lib/islands';
import { buildPreview, detectMapping, parseFile } from './parseFile';
import type {
  BulkResult,
  ColumnMapping,
  ExistingHints,
  ImportStep,
  ParsedRow,
  PreviewRow
} from './types';
import { EMPTY_MAPPING, REQUIRED, TARGET_LABEL } from './types';

type ToastFn = (message: string, tone?: 'success' | 'error' | 'info') => void;

type UseClientImportArgs = {
  open: boolean;
  onCompleted: () => void;
  toast: ToastFn;
};

type UseClientImportReturn = {
  step: ImportStep;
  file: File | null;
  parsing: boolean;
  parseError: string | null;
  headers: string[];
  mapping: ColumnMapping;
  preview: PreviewRow[];
  previewSlice: PreviewRow[];
  counters: { ok: number; conflict: number; error: number; unknownIsland: number; total: number };
  missingRequired: ReturnType<typeof getMissingRequired>;
  submitting: boolean;
  downloadingTemplate: boolean;
  result: BulkResult | null;
  ingest: (file: File) => Promise<void>;
  resetFile: () => void;
  setMappingField: (target: keyof ColumnMapping, value: string) => void;
  submit: () => Promise<void>;
  downloadTemplate: () => Promise<void>;
};

function getMissingRequired(mapping: ColumnMapping) {
  return REQUIRED.filter((target) => !mapping[target]);
}

/** Encapsulates all import-flow state, parsing, validation and submission. */
export function useClientImport({ open, onCompleted, toast }: UseClientImportArgs): UseClientImportReturn {
  const [file, setFile] = useState<File | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<ParsedRow[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({ ...EMPTY_MAPPING });
  const [existing, setExisting] = useState<ExistingHints>({
    codes: new Set(),
    nifs: new Set(),
    phones: new Set()
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);

  // Fetch existing-data hints when the dialog opens (used for dedup conflict markers).
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

  // Reset everything when the dialog closes so the next open starts clean.
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

  const ingest = useCallback(async (nextFile: File) => {
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
  }, []);

  const resetFile = useCallback(() => {
    setFile(null);
    setRawRows([]);
  }, []);

  const setMappingField = useCallback((target: keyof ColumnMapping, value: string) => {
    setMapping((current) => ({ ...current, [target]: value }));
  }, []);

  const preview = useMemo(
    () => buildPreview(rawRows, mapping, existing),
    [rawRows, mapping, existing]
  );

  const counters = useMemo(() => {
    let ok = 0;
    let conflict = 0;
    let error = 0;
    // Ilhas que nem depois da conversão caem na lista fechada: entram como
    // vieram, mas o utilizador fica a saber antes de gravar.
    let unknownIsland = 0;
    for (const row of preview) {
      if (row.errors.length > 0) error += 1;
      else if (row.conflict) conflict += 1;
      else ok += 1;
      if (row.values.island && !isKnownIsland(row.values.island)) unknownIsland += 1;
    }
    return { ok, conflict, error, unknownIsland, total: preview.length };
  }, [preview]);

  const missingRequired = useMemo(() => getMissingRequired(mapping), [mapping]);
  const previewSlice = useMemo(() => preview.slice(0, 14), [preview]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (missingRequired.length > 0) {
      toast(
        `Mapeia o campo obrigatorio: ${missingRequired.map((t) => TARGET_LABEL[t]).join(', ')}`,
        'error'
      );
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
  }, [submitting, missingRequired, preview, toast, onCompleted]);

  const downloadTemplate = useCallback(async () => {
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
  }, [downloadingTemplate, toast]);

  const step: ImportStep = result ? 'result' : rawRows.length > 0 ? 'preview' : 'upload';

  return {
    step,
    file,
    parsing,
    parseError,
    headers,
    mapping,
    preview,
    previewSlice,
    counters,
    missingRequired,
    submitting,
    downloadingTemplate,
    result,
    ingest,
    resetFile,
    setMappingField,
    submit,
    downloadTemplate
  };
}
