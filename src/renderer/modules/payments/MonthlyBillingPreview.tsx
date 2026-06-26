import { Button, Message } from '../../components';
import { formatCve, formatPtDate, formatPtMonth } from '../../lib/format';

export type BillingPreviewRow = {
  serviceId: number;
  clientId: number;
  clientName: string;
  planName: string | null;
  amountCve: number;
  dueDate: string;
};

export type BillingPreview = {
  referenceMonth: string;
  activeServices: number;
  alreadyBilled: number;
  toCreate: BillingPreviewRow[];
  totalCve: number;
};

type MonthlyBillingPreviewProps = {
  preview: BillingPreview;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export function MonthlyBillingPreview({ preview, loading, onConfirm, onClose }: MonthlyBillingPreviewProps) {
  return (
    <div className="monthly-preview" id="monthly-preview">
      <div className="module-header">
        <div>
          <p className="eyebrow">Pre-visualizacao da geracao</p>
          <h2>Mensalidades de {formatPtMonth(preview.referenceMonth)}</h2>
        </div>
        <div className="inline-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={onConfirm}
            disabled={loading || preview.toCreate.length === 0}
          >
            {loading ? 'A gerar...' : `Confirmar e gerar (${preview.toCreate.length})`}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
        </div>
      </div>
      <div className="monthly-preview-summary">
        <span className="monthly-preview-chip">
          <small>Servicos ativos</small>
          <strong>{preview.activeServices}</strong>
        </span>
        <span className="monthly-preview-chip">
          <small>Ja cobrados</small>
          <strong>{preview.alreadyBilled}</strong>
        </span>
        <span className="monthly-preview-chip highlight">
          <small>A criar</small>
          <strong>{preview.toCreate.length}</strong>
        </span>
        <span className="monthly-preview-chip highlight">
          <small>Total</small>
          <strong>{formatCve(preview.totalCve)}</strong>
        </span>
      </div>
      {preview.toCreate.length > 0 ? (
        <div className="monthly-preview-table" role="table" aria-label="Cobrancas a criar">
          <div className="monthly-preview-row monthly-preview-row--head" role="row">
            <span role="columnheader">Cliente</span>
            <span role="columnheader">Plano</span>
            <span role="columnheader">Vencimento</span>
            <span role="columnheader" className="monthly-preview-amount">Valor</span>
          </div>
          {preview.toCreate.map((row) => (
            <div className="monthly-preview-row" role="row" key={row.serviceId}>
              <span role="cell">{row.clientName}</span>
              <span role="cell" className="monthly-preview-muted">{row.planName || '-'}</span>
              <span role="cell" className="monthly-preview-muted">{formatPtDate(row.dueDate)}</span>
              <span role="cell" className="monthly-preview-amount">{formatCve(row.amountCve)}</span>
            </div>
          ))}
        </div>
      ) : (
        <Message>
          Nada a criar. Os {preview.alreadyBilled} servicos ativos ja tem cobranca para este mes.
        </Message>
      )}
    </div>
  );
}
