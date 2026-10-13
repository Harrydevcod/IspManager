import { useState } from 'react';
import { Copy, Link2 } from 'lucide-react';
import { Button, Field, Message } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';

export type StripeLinkInfo = {
  id: number;
  url: string | null;
  amountCve: number;
  status: 'creating' | 'open' | 'paid' | 'void' | 'review' | 'refunded' | 'refund_pending';
  note: string | null;
};

/** O que a ficha da fatura sabe do Stripe; `enabled` = ligado e pronto a cobrar. */
export type StripeState = {
  enabled: boolean;
  link: StripeLinkInfo | null;
  /** Origem Stripe não muda enquanto um reembolso está pendente ou em revisão. */
  receiptIds?: number[];
  /** Recibos que entraram por Stripe e ainda se podem reembolsar. */
  refundableReceiptIds?: number[];
};

export const STRIPE_LINK_LABEL: Record<StripeLinkInfo['status'], string> = {
  creating: 'Link por criar',
  open: 'Link à espera de pagamento',
  paid: 'Pago por Stripe',
  void: 'Link anulado',
  review: 'Pagamento por rever',
  refunded: 'Reembolsado',
  refund_pending: 'Reembolso à espera de confirmação'
};

type StripeLinkPanelProps = {
  paymentId: number;
  balanceCve: number;
  link: StripeLinkInfo | null;
  disabled: boolean;
  /** Um link novo nasceu: a ficha volta a pedir o estado. */
  onChanged: () => void;
  onCancel: () => void;
};

/**
 * Stripe escolhido como via de pagamento: em vez de um recibo, sai um link.
 * O recibo nasce sozinho quando o Stripe confirmar o pagamento.
 */
export function StripeLinkPanel({ paymentId, balanceCve, link, disabled, onChanged, onCancel }: StripeLinkPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [fresh, setFresh] = useState<StripeLinkInfo | null>(null);

  // Um link aberto com outro valor já não serve: o saldo mudou depois dele.
  const current = fresh ?? link;
  const usable = current?.status === 'open' && current.url && Math.round(current.amountCve * 100) === Math.round(balanceCve * 100)
    ? current
    : null;

  async function createLink() {
    setBusy(true);
    setError('');
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/payments/${paymentId}/stripe-link`, { method: 'POST' });
      const body = await response.json().catch(() => ({})) as StripeLinkInfo & { error?: string };
      if (!response.ok) {
        setError(body.error || 'Nao foi possivel criar o link de pagamento.');
        return;
      }
      setFresh(body);
      onChanged();
    } catch {
      setError('Falha de rede ao pedir o link de pagamento.');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('Nao foi possivel copiar: selecione o link e copie a mao.');
    }
  }

  return (
    <>
      {usable ? (
        <Field label={`Link de pagamento · ${formatCve(usable.amountCve)}`} value={usable.url ?? ''} readOnly onFocus={(event) => event.target.select()} />
      ) : (
        <Message>
          O ISPM cria um link de {formatCve(balanceCve)} para enviar ao cliente. Não é registado recibo agora: nasce sozinho quando o Stripe confirmar o pagamento.
        </Message>
      )}
      {error && <Message tone="error">{error}</Message>}
      <div className="inline-actions">
        {usable ? (
          <Button leadingIcon={<Copy size={16} aria-hidden />} onClick={() => void copyLink(usable.url ?? '')}>
            {copied ? 'Link copiado' : 'Copiar link'}
          </Button>
        ) : (
          <Button leadingIcon={<Link2 size={16} aria-hidden />} onClick={() => void createLink()} loading={busy} disabled={disabled || busy}>
            {busy ? 'A criar link...' : 'Gerar link de pagamento'}
          </Button>
        )}
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Fechar</Button>
      </div>
    </>
  );
}
