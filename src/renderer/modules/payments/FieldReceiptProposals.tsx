import { apiUrl } from '../../lib/api';
import { useCallback, useEffect, useState } from 'react';
import { Check, Smartphone, X } from 'lucide-react';
import { Button, Message } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';
import { AccountSelect } from '../treasury/AccountSelect';

export type ReceiptProposal = {
  id: string;
  occurredAt: string;
  clientId: number;
  clientCode: string;
  clientName: string;
  amountCve: number;
  method: 'numerario' | 'transferencia';
  note: string | null;
  /** A conta indicada no terreno, quando a app o permite (0.14+). */
  accountId: number | null;
  target: { paymentId: number; dueDate: string; balanceCve: number } | null;
};

const ENDPOINT = apiUrl('/api/companion/receipt-proposals');
const METHOD_LABEL = { numerario: 'Numerário', transferencia: 'Transferência' } as const;
const when = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Recebimentos em mão registados na app móvel. Nenhum entra na caixa sozinho:
 * só "Confirmar" o transforma em recibo (na fatura em aberto mais antiga, com a
 * data do terreno), na caixa ou no banco escolhido aqui. Sem propostas, o painel
 * não ocupa espaço.
 */
export function FieldReceiptProposals({ onConfirmed }: { onConfirmed: () => void }) {
  const [proposals, setProposals] = useState<ReceiptProposal[]>([]);
  const [accountFor, setAccountFor] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    authFetch(ENDPOINT)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ReceiptProposal[]) => {
        setProposals(rows);
        // A conta que veio do terreno aparece escolhida; o resto deixa o
        // AccountSelect propor (a caixa predefinida, no numerário).
        setAccountFor((current) => {
          const next = { ...current };
          for (const row of rows) {
            if (next[row.id] === undefined && row.accountId != null) next[row.id] = String(row.accountId);
          }
          return next;
        });
      })
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
      const account = accountFor[id];
      const response = await authFetch(`${ENDPOINT}/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'confirm' && account ? { accountId: Number(account) } : {})
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
            <AccountSelect
              purpose={p.method}
              value={accountFor[p.id] ?? ''}
              onChange={(value) => setAccountFor((current) => ({ ...current, [p.id]: value }))}
              disabled={busyId !== null}
              className="field-receipt-account"
            />
            <div className="field-receipt-actions">
              <Button variant="critical" leadingIcon={<X size={14} aria-hidden />} disabled={busyId !== null} onClick={() => void decide(p.id, 'reject')}>
                Rejeitar
              </Button>
              <Button
                leadingIcon={<Check size={14} aria-hidden />}
                disabled={busyId !== null || !p.target || !accountFor[p.id]}
                onClick={() => void decide(p.id, 'confirm')}
              >
                {busyId === p.id ? 'A registar...' : 'Confirmar'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
