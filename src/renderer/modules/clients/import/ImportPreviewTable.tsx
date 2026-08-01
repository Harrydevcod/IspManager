import { FileSpreadsheet, FileText, X } from 'lucide-react';
import { Button } from '../../../components';
import type { PreviewRow } from './types';

type Counters = {
  ok: number;
  conflict: number;
  error: number;
  unknownIsland: number;
  total: number;
};

type ImportPreviewTableProps = {
  file: File | null;
  counters: Counters;
  previewSlice: PreviewRow[];
  totalRows: number;
  onReset: () => void;
};

function statusFor(row: PreviewRow): { className: string; label: string } {
  if (row.errors.length > 0) {
    return { className: 'is-error', label: row.errors.join(' · ') };
  }
  if (row.conflict === 'clientCode') return { className: 'is-conflict', label: 'codigo ja existe' };
  if (row.conflict === 'nif') return { className: 'is-conflict', label: 'NIF ja existe' };
  if (row.conflict === 'phone') return { className: 'is-conflict', label: 'telefone ja existe' };
  return { className: 'is-ok', label: 'ok' };
}

/** Preview header with counters + file chip + the first N rows shown as a table. */
export function ImportPreviewTable({
  file,
  counters,
  previewSlice,
  totalRows,
  onReset
}: ImportPreviewTableProps) {
  const isCsv = file?.name.toLowerCase().endsWith('.csv');

  return (
    <div className="import-preview">
      <header className="import-preview-head">
        <div className="import-file">
          {file && (isCsv ? <FileText size={16} aria-hidden /> : <FileSpreadsheet size={16} aria-hidden />)}
          <span>{file?.name}</span>
          <Button
            variant="ghost"
            size="sm"
            className="import-file-reset"
            leadingIcon={<X size={12} aria-hidden />}
            onClick={onReset}
          >
            mudar
          </Button>
        </div>
        <div className="import-counters">
          <span className="import-counter import-counter-ok">{counters.ok} importar</span>
          <span className="import-counter import-counter-conflict">{counters.conflict} duplicado</span>
          <span className="import-counter import-counter-error">{counters.error} com erro</span>
          {/* Grafias reconhecidas já foram convertidas; isto é o que sobrou. */}
          {counters.unknownIsland > 0 && (
            <span className="import-counter import-counter-conflict">
              {counters.unknownIsland} ilha por reconhecer
            </span>
          )}
          <span className="import-counter import-counter-total">{counters.total} total</span>
        </div>
      </header>

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
              const status = statusFor(row);
              return (
                <tr key={row.index} className={status.className}>
                  <td>{String(row.index + 1).padStart(2, '0')}</td>
                  <td className="import-status-cell">{status.label}</td>
                  <td className="import-cell-code">{row.values.clientCode || <span className="muted">auto</span>}</td>
                  <td className="import-cell-code">{row.values.nif || <span className="muted">—</span>}</td>
                  <td>{row.values.fullName || <em className="muted">—</em>}</td>
                  <td>{row.values.phone || <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {totalRows > previewSlice.length && (
          <p className="import-table-more">
            + {totalRows - previewSlice.length} linhas adicionais (todas processadas).
          </p>
        )}
      </div>
    </div>
  );
}
