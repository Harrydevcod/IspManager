import { Send } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState } from '../../components';
import { formatCve } from '../../lib/format';

export type WhatsappNoticeType = 'overdue' | 'suspension';

export type OverdueNotifyPreview = {
  noticeType: WhatsappNoticeType;
  total: number;
  eligible: Array<{ paymentId: number; clientName: string; clientCode: string; phone: string | null; amountCve: number; dueDate: string; daysOverdue: number }>;
  skipped: Array<{ paymentId: number; clientName: string; reason?: string }>;
};

type OverdueNotifyDialogProps = {
  preview: OverdueNotifyPreview | null;
  suspensionNoticeDays: number;
  sending: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function OverdueNotifyDialog({ preview, suspensionNoticeDays, sending, onClose, onConfirm }: OverdueNotifyDialogProps) {
  return (
    <Dialog
      open={!!preview}
      onClose={onClose}
      eyebrow="WhatsApp em massa"
      title={preview?.noticeType === 'suspension' ? 'Avisar suspensao' : 'Notificar atrasados'}
      size="md"
      closeOnBackdrop={!sending}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={sending}>Cancelar</Button>
          <Button
            onClick={onConfirm}
            disabled={sending || !preview || preview.eligible.length === 0}
          >
            {sending
              ? 'A enviar...'
              : preview && preview.eligible.length > 0
                ? `Enviar para ${preview.eligible.length}`
                : 'Sem destinatarios'}
          </Button>
        </>
      }
    >
      {preview && (
        <div className="overdue-notify">
          <p className="overdue-notify-summary">
            <strong>{preview.total}</strong>{' '}
            {preview.noticeType === 'suspension'
              ? `pagamento(s) com ${suspensionNoticeDays}+ dias de atraso. `
              : 'pagamento(s) em atraso. '}
            <strong>{preview.eligible.length}</strong> elegivel(eis) para WhatsApp.{' '}
            {preview.skipped.length > 0 && (
              <span className="overdue-notify-skip">
                {preview.skipped.length} ignorado(s) (opt-out ou sem telefone).
              </span>
            )}
          </p>

          {preview.eligible.length > 0 ? (
            <ul className="overdue-notify-list">
              {preview.eligible.map((row) => (
                <li key={row.paymentId}>
                  <div className="overdue-notify-meta">
                    <small className="entity-code">{row.clientCode}</small>
                    <strong>{row.clientName}</strong>
                    <small>{row.phone}</small>
                  </div>
                  <Badge tone="danger">{row.daysOverdue}d</Badge>
                  <span className="overdue-notify-amount">{formatCve(row.amountCve)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              size="sm"
              icon={Send}
              title="Sem clientes elegíveis"
              description="Não há cobranças em atraso com telefone WhatsApp válido para envio em massa."
            />
          )}

          {preview.skipped.length > 0 && (
            <details className="overdue-notify-skipped">
              <summary>Ignorados ({preview.skipped.length})</summary>
              <ul>
                {preview.skipped.map((row) => (
                  <li key={row.paymentId}>
                    {row.clientName} <small>({row.reason})</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Dialog>
  );
}
