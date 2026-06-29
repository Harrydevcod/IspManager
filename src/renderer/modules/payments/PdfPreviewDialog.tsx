import { Download } from 'lucide-react';
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
};

export function PdfPreviewDialog({ preview, document, onClose, onDownload }: PdfPreviewDialogProps) {
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
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
          {preview && (
            <Button
              leadingIcon={<Download size={14} aria-hidden />}
              onClick={() => onDownload(preview.payment, preview.type)}
            >
              Descarregar
            </Button>
          )}
        </>
      }
    >
      {preview && (
        document.error ? (
          <Message tone="error">Nao foi possivel carregar o documento.</Message>
        ) : document.objectUrl ? (
          <iframe
            className="pdf-dialog-frame"
            title={preview.type === 'receipt' ? 'Pre-visualizacao do recibo' : 'Pre-visualizacao da fatura'}
            src={document.objectUrl}
          />
        ) : (
          <Message>A carregar documento…</Message>
        )
      )}
    </Dialog>
  );
}
