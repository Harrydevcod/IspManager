import { Download, Printer } from 'lucide-react';
import { Button, Dialog, Message } from '../../components';
import type { PaymentRow } from '../../types';

type PdfPreview = {
  payment: PaymentRow;
  type: 'invoice' | 'receipt';
};

type PdfDocumentState = {
  objectUrl: string | null;
  error: boolean;
};

type PdfPreviewDialogProps = {
  preview: PdfPreview | null;
  document: PdfDocumentState;
  onClose: () => void;
  onDownload: (payment: PaymentRow, type: 'invoice' | 'receipt') => void;
  onPrint: (payment: PaymentRow, type: 'invoice' | 'receipt') => void;
};

export function PdfPreviewDialog({ preview, document, onClose, onDownload, onPrint }: PdfPreviewDialogProps) {
  return (
    <Dialog
      open={!!preview}
      onClose={onClose}
      eyebrow={preview?.type === 'receipt' ? 'Recibo' : 'Fatura'}
      title={
        preview
          ? preview.type === 'receipt'
            ? (preview.payment.receiptNumber || `Recibo #${preview.payment.id}`)
            : (preview.payment.invoiceNumber || `Fatura #${preview.payment.id}`)
          : ''
      }
      size="lg"
      actions={<Button variant="secondary" onClick={onClose}>Fechar</Button>}
    >
      {preview && (
        document.error ? (
          <Message tone="error">Nao foi possivel carregar o documento.</Message>
        ) : document.objectUrl ? (
          <div className="pdf-preview-shell pdf-preview-shell-dialog">
            <div className="pdf-preview-toolbar" aria-label="Acoes do documento">
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Download size={14} aria-hidden />}
                onClick={() => onDownload(preview.payment, preview.type)}
              >
                Descarregar
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Printer size={14} aria-hidden />}
                onClick={() => onPrint(preview.payment, preview.type)}
              >
                Imprimir
              </Button>
            </div>
            <iframe
              className="pdf-dialog-frame"
              title={preview.type === 'receipt' ? 'Pre-visualizacao do recibo' : 'Pre-visualizacao da fatura'}
              // #toolbar=0 hides Chromium PDF viewer controls; app buttons above
              // preserve the correct authenticated download and print flows.
              src={`${document.objectUrl}#toolbar=0`}
            />
          </div>
        ) : (
          <Message>A carregar documento...</Message>
        )
      )}
    </Dialog>
  );
}
