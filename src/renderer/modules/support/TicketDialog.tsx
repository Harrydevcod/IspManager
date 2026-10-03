import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, Field, Message, Select, Textarea } from '../../components';
import { formatPtDateTime } from '../../lib/format';
import {
  CATEGORY_LABEL, CHANNEL_LABEL, PRIORITY_LABEL, STATUS_LABEL, STATUS_TONE, ticketsRequest,
  type Assignee, type TicketDetail, type TicketPriority, type TicketStatus
} from './support-api';

const ENTRY_LABEL = { nota: 'Nota', mudanca_estado: 'Estado', os_criada: 'OS' } as const;
const ORDER_STATUS_LABEL: Record<string, string> = {
  aguarda: 'Aguarda', agendada: 'Agendada', em_curso: 'Em curso', concluida: 'Concluída', cancelada: 'Cancelada'
};
const FINAL = new Set<TicketStatus>(['resolvido', 'fechado']);

/** Um pedido: a linha do tempo e o que se pode fazer com ele. */
export function TicketDialog({ id, assignees, canWrite, onClose, onChanged }: {
  id: number;
  assignees: Assignee[];
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [note, setNote] = useState('');
  const [nextStatus, setNextStatus] = useState<TicketStatus | ''>('');
  const [orderTitle, setOrderTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ticketsRequest<TicketDetail>(`/${id}`)
      .then((body) => { if (alive) setTicket(body); })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [id]);

  const run = useCallback(async (path: string, method: string, body: unknown, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      setTicket(await ticketsRequest<TicketDetail>(path, { method, body }));
      after?.();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível guardar.');
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const saveNoteOrStatus = () => {
    if (nextStatus) {
      void run(`/${id}`, 'PATCH', { status: nextStatus, note: note.trim() || null }, () => { setNote(''); setNextStatus(''); });
    } else if (note.trim()) {
      void run(`/${id}/entries`, 'POST', { body: note.trim() }, () => setNote(''));
    }
  };

  return (
    <Dialog open onClose={onClose} size="lg"
      eyebrow={ticket ? `Pedido nº ${ticket.id} · ${CATEGORY_LABEL[ticket.category]} · ${CHANNEL_LABEL[ticket.channel]}` : 'Pedido de assistência'}
      title={ticket?.subject ?? 'A ler o pedido…'}>
      <div className="support-ticket-dialog">
      {/* Com o pedido aberto, o erro aparece junto aos botões: no topo ficava fora da vista. */}
      {error && !ticket && <Message tone="error">{error}</Message>}
      {ticket && (
        <div className="support-ticket client-form">
          <dl className="support-ticket-facts">
            <div><dt>Cliente</dt><dd>{ticket.clientCode} · {ticket.clientName}</dd></div>
            <div><dt>Serviço</dt><dd>{ticket.serviceId ? `${ticket.planName ?? 'Sem plano'}${ticket.pppoeUsername ? ` · ${ticket.pppoeUsername}` : ''}` : '—'}</dd></div>
            <div><dt>Estado</dt><dd><Badge tone={STATUS_TONE[ticket.status]}>{STATUS_LABEL[ticket.status]}</Badge></dd></div>
            <div><dt>Aberto</dt><dd>{formatPtDateTime(ticket.openedAt)}{ticket.openedByName ? ` · ${ticket.openedByName}` : ''}</dd></div>
          </dl>

          {canWrite && (
            <div className="support-ticket-controls">
              <Select label="Prioridade" value={ticket.priority} disabled={busy}
                onChange={(event) => void run(`/${id}`, 'PATCH', { priority: event.target.value as TicketPriority })}>
                {Object.entries(PRIORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
              <Select label="Técnico" value={ticket.assignedToId ?? ''} disabled={busy}
                onChange={(event) => void run(`/${id}`, 'PATCH', { assignedTo: event.target.value ? Number(event.target.value) : null })}>
                <option value="">Ninguém</option>
                {assignees.map((user) => <option key={user.id} value={user.id}>{user.fullName}</option>)}
              </Select>
            </div>
          )}

          <ol className="support-timeline" aria-label="Linha do tempo do pedido">
            {ticket.entries.map((entry) => (
              <li key={entry.id} className={`support-timeline-entry is-${entry.kind}`}>
                <span className="support-timeline-meta">
                  {ENTRY_LABEL[entry.kind]} · {formatPtDateTime(entry.createdAt)}{entry.authorName ? ` · ${entry.authorName}` : ''}
                </span>
                <p>{entry.body}</p>
              </li>
            ))}
          </ol>

          {canWrite && (
            <div className="support-ticket-compose">
              <Textarea label="Acrescentar" rows={2} maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)}
                hint={nextStatus && FINAL.has(nextStatus) ? 'Diga o que se fez: é obrigatório para resolver ou fechar.' : undefined} />
              {error && <Message tone="error">{error}</Message>}
              <div className="support-ticket-compose-actions">
                <Select label="Mudar estado" hideLabel value={nextStatus} disabled={busy}
                  onChange={(event) => setNextStatus(event.target.value as TicketStatus | '')}>
                  <option value="">Manter o estado</option>
                  {(Object.keys(STATUS_LABEL) as TicketStatus[]).filter((status) => status !== ticket.status)
                    .map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
                </Select>
                <Button onClick={saveNoteOrStatus} loading={busy} disabled={!note.trim() && !nextStatus}>
                  {nextStatus ? 'Guardar' : 'Acrescentar nota'}
                </Button>
              </div>
            </div>
          )}

          <section className="support-ticket-orders" aria-label="OS técnicas do pedido">
            <h3>OS técnicas</h3>
            {ticket.workOrders.length === 0
              ? <p className="support-muted">Nenhuma OS ainda.</p>
              : (
                <ul>
                  {ticket.workOrders.map((order) => (
                    <li key={order.id}>OS nº {order.id} · {order.title} · {ORDER_STATUS_LABEL[order.status] ?? order.status}{order.assignedTo ? ` · ${order.assignedTo}` : ''}</li>
                  ))}
                </ul>
              )}
            {canWrite && !FINAL.has(ticket.status) && (
              <div className="support-ticket-compose-actions">
                <Field label="Título da OS" hideLabel placeholder={ticket.subject} value={orderTitle} maxLength={140}
                  onChange={(event) => setOrderTitle(event.target.value)} />
                <Button variant="secondary" loading={busy}
                  onClick={() => void run(`/${id}/work-orders`, 'POST', { title: orderTitle.trim() || undefined }, () => setOrderTitle(''))}>
                  Criar OS
                </Button>
              </div>
            )}
          </section>
        </div>
      )}
      </div>
    </Dialog>
  );
}
