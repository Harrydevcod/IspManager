import { Download, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Button } from '../../../components';

type ImportDropzoneProps = {
  parsing: boolean;
  parseError: string | null;
  downloadingTemplate: boolean;
  onPick: (file: File) => void;
  onDownloadTemplate: () => void;
  templateLabel?: string;
  templateHint?: string;
  help?: ReactNode;
  accept?: string;
  acceptLabel?: string;
};

/** First step of the import flow: drag-and-drop area, file picker, template download, help. */
export function ImportDropzone({
  parsing,
  parseError,
  downloadingTemplate,
  onPick,
  onDownloadTemplate,
  templateLabel = 'Descarregar template Excel',
  templateHint = 'Cabeçalhos prontos + 2 linhas de exemplo + folha de instruções.',
  help,
  accept = '.csv,.xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  acceptLabel = '.csv .xlsx .xls'
}: ImportDropzoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragHover, setDragHover] = useState(false);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragHover(false);
    const next = event.dataTransfer.files?.[0];
    if (next && !parsing) onPick(next);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragHover(true);
  }

  return (
    <div className="import-upload">
      <div
        className={`import-dropzone${dragHover ? ' is-hover' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragHover(false)}
        onClick={() => { if (!parsing) fileInputRef.current?.click(); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!parsing) fileInputRef.current?.click();
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
          ou <strong>clica para escolher</strong> &middot; aceita {acceptLabel}
        </p>
        {/* eslint-disable-next-line no-restricted-syntax -- hidden file input is the canonical picker pattern; Field primitive doesn't model type=file */}
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          hidden
          disabled={parsing}
          onChange={(event) => {
            const next = event.target.files?.[0];
            if (next) onPick(next);
            event.target.value = '';
          }}
        />
      </div>
      {parseError && <p className="import-error">{parseError}</p>}
      <div className="import-template-row">
        <Button
          variant="secondary"
          size="sm"
          className="import-template-button"
          loading={downloadingTemplate}
          leadingIcon={<Download size={14} aria-hidden />}
          onClick={onDownloadTemplate}
        >
          {downloadingTemplate ? 'A preparar...' : templateLabel}
        </Button>
        <span className="import-template-hint">
          {templateHint}
        </span>
      </div>
      <details className="import-help">
        <summary>O que deve conter o ficheiro</summary>
        {help ?? <p>
          Primeira linha = cabeçalhos. Colunas reconhecidas automaticamente:
          {' '}
          <em>código, NIF, nome, telefone, email, morada, ilha, zona</em>.
          Podes mapear manualmente no próximo passo. Linhas duplicadas (por código,
          NIF ou telefone) são ignoradas — o import é seguro de repetir.
        </p>}
      </details>
    </div>
  );
}
