import { Button, Dialog, useToast } from '../../../components';
import { ImportColumnMapper } from './ImportColumnMapper';
import { ImportDropzone } from './ImportDropzone';
import { ImportPreviewTable } from './ImportPreviewTable';
import { ImportResult } from './ImportResult';
import { useClientImport } from './useClientImport';
import './ClientImportDialog.css';

export type ClientImportDialogProps = {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
};

function submitLabel(submitting: boolean, ok: number) {
  if (submitting) return 'A importar...';
  if (ok === 0) return 'Nenhuma linha valida';
  return `Importar ${ok} cliente(s)`;
}

/**
 * Orchestrator for the CSV/Excel client import flow.
 * State + parsing + submit live in `useClientImport`; each step renders a focused
 * sub-component (Dropzone / ColumnMapper + PreviewTable / Result).
 */
export function ClientImportDialog({ open, onClose, onCompleted }: ClientImportDialogProps) {
  const { toast } = useToast();
  const imp = useClientImport({ open, onCompleted, toast });

  const actions =
    imp.step === 'preview' ? (
      <>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button
          variant="primary"
          loading={imp.submitting}
          disabled={imp.counters.ok === 0 || imp.missingRequired.length > 0}
          onClick={() => void imp.submit()}
        >
          {submitLabel(imp.submitting, imp.counters.ok)}
        </Button>
      </>
    ) : imp.step === 'result' ? (
      <Button variant="primary" onClick={onClose}>Fechar</Button>
    ) : (
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Importacao"
      title="Importar clientes"
      size="lg"
      actions={actions}
    >
      {imp.step === 'upload' && (
        <ImportDropzone
          parsing={imp.parsing}
          parseError={imp.parseError}
          downloadingTemplate={imp.downloadingTemplate}
          onPick={(file) => void imp.ingest(file)}
          onDownloadTemplate={() => void imp.downloadTemplate()}
        />
      )}

      {imp.step === 'preview' && (
        <>
          <ImportPreviewTable
            file={imp.file}
            counters={imp.counters}
            previewSlice={imp.previewSlice}
            totalRows={imp.preview.length}
            onReset={imp.resetFile}
          />
          <ImportColumnMapper
            headers={imp.headers}
            mapping={imp.mapping}
            onChange={imp.setMappingField}
          />
        </>
      )}

      {imp.step === 'result' && imp.result && <ImportResult result={imp.result} />}
    </Dialog>
  );
}
