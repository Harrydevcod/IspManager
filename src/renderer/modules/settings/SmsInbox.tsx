import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatPtDate } from '../../lib/format';

type InboxMessage = {
  id: number;
  clientId: number | null;
  clientName: string | null;
  phone: string;
  body: string;
  receivedAt: string;
  readAt: string | null;
};

const API = 'http://127.0.0.1:3001/api/sms/inbox';

/**
 * Respostas dos clientes aos SMS, reencaminhadas pela app móvel (só de números
 * que são clientes). Em Definições mostra todas; na ficha, só as do cliente.
 * Sem mensagens, não ocupa espaço.
 */
export function SmsInbox({ clientId }: { clientId?: number }) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    authFetch(clientId ? `${API}?clientId=${clientId}` : API)
      .then((r) => (r.ok ? r.json() : { unread: 0, messages: [] }))
      .then((data: { unread: number; messages: InboxMessage[] }) => {
        setMessages(data.messages);
        setUnread(clientId ? data.messages.filter((m) => !m.readAt).length : data.unread);
      })
      .catch(() => undefined);
  }, [clientId]);

  useEffect(() => { load(); }, [load]);

  async function markRead() {
    const ids = messages.filter((m) => !m.readAt).map((m) => m.id);
    if (!ids.length) return;
    await authFetch(`${API}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
    load();
  }

  if (messages.length === 0) return null;

  return (
    <section className="client-dunning sms-inbox" aria-label="SMS recebidos">
      <header>
        <strong>SMS recebidos</strong>
        <small>{unread > 0 ? `${unread} por ler` : `${messages.length} mensagem(ns)`}</small>
        {unread > 0 && <Button variant="secondary" size="sm" onClick={() => void markRead()}>Marcar como lidas</Button>}
      </header>
      <ul className="client-dunning-timeline">
        {messages.map((m) => (
          <li key={m.id} data-unread={m.readAt ? undefined : 'true'}>
            <span>
              <strong>{clientId ? m.body : `${m.clientName ?? m.phone}: ${m.body}`}</strong>
              <small>{formatPtDate(m.receivedAt)} · {m.phone}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
