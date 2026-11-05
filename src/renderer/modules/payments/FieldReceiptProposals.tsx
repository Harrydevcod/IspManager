import { useCallback, useEffect, useState } from 'react';
import { Check, Smartphone, X } from 'lucide-react';
import { Button, Message } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';

export type ReceiptProposal = {
  id: string;
  occurredAt: string;
  clientId: number;
  clientCode: string;
  clientName: string;
  amountCve: number;
  method: 'numerario' | 'transferencia';
  note: string | null;
  target: { paymentId: number; dueDate: string; balanceCve: number } | null;
};

const ENDPOINT = 'http://127.0.0.1:3001/api/companion/receipt-proposals';
const METHOD_LABEL = { numerario: 'Numerário', transferencia: 'Transferência' } as const;
const when = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Recebimentos em mão registados na app móvel. Nenhum entra na caixa sozinho:
 * só "Confirmar" o transforma em recibo (na fatura em aberto mais antiga, com a
 * data do terreno). Sem propostas, o painel não ocupa espaço.
 */
export function FieldReceiptProposals({ onConfirmed }: { onConfirmed: () => void }) {
  const [proposals, setProposals] = useState<ReceiptProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    authFetch(ENDPOINT)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ReceiptProposal[]) => setProposals(rows))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    // O telemóvel é lido de minuto a minuto; o painel acompanha.
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function decide(id: string, action: 'confirm' | 'reject') {
    setBusyId(id);
    setError('');
    try {
      const response = await authFetch(`${ENDPOINT}/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error || 'Não foi possível decidir este recebimento.');
        return;
      }
      if (action === 'confirm') onConfirmed();
      load();
    } finally {
      setBusyId(null);
    }
  }

  if (proposals.length === 0) return null;

  return (
    <section className="field-receipts" aria-label="Recebimentos do terreno">
      <header className="field-receipts-head">
        <Smartphone size={16} aria-hidden />
        <h3>Recebimentos do terreno · {proposals.length}</h3>
        <span>Registados na app móvel. Só entram na caixa depois de confirmados.</span>
      </header>
      {error && <Message>{error}</Message>}
      <ul>
        {proposals.map((p) => (
          <li key={p.id} className="field-receipt">
            <div className="field-receipt-who">
              <strong>{p.clientName}</strong>
              <span>{p.clientCode} · {METHOD_LABEL[p.method]} · {when.format(new Date(p.occurredAt))}</span>
              {p.note && <span className="field-receipt-note">{p.note}</span>}
            </div>
            <div className="field-receipt-amount">
              <strong>{formatCve(p.amountCve)}</strong>
              <span>{p.target ? `paga a fatura de ${p.target.dueDate.slice(0, 10)} (${formatCve(p.target.balanceCve)})` : 'sem faturas em aberto'}</span>
            </div>
            <div className="field-receipt-actions">
              <Button variant="critical" leadingIcon={<X size={14} aria-hidden />} disabled={busyId !== null} onClick={() => void decide(p.id, 'reject')}>
                Rejeitar
              </Button>
              <Button leadingIcon={<Check size={14} aria-hidden />} disabled={busyId !== null || !p.target} onClick={() => void decide(p.id, 'confirm')}>
                {busyId === p.id ? 'A registar...' : 'Confirmar'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
