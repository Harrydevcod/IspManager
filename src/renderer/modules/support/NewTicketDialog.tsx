import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Combobox, Dialog, Field, Message, Select, Textarea } from '../../components';
import { authFetch } from '../../lib/auth';
import type { Client, ServiceRow } from '../../types';
import {
  CATEGORY_LABEL, CHANNEL_LABEL, PRIORITY_LABEL, ticketsRequest,
  type TicketCategory, type TicketChannel, type TicketDetail, type TicketPriority
} from './support-api';

type Form = {
  clientId: number | null;
  serviceId: string;
  subject: string;
  channel: TicketChannel;
  category: TicketCategory;
  priority: TicketPriority;
  note: string;
};

const EMPTY: Omit<Form, 'clientId'> = { serviceId: '', subject: '', channel: 'telefone', category: 'sem_ligacao', priority: 'media', note: '' };

/**
 * Registar o que o cliente reportou. Abre-se na secção Assistência ou na ficha do cliente,
 * que já traz o cliente escolhido.
 */
export function NewTicketDialog({ open, clientId, onClose, onCreated }: {
  open: boolean;
  clientId?: number;
  onClose: () => void;
  onCreated: (ticket: TicketDetail) => void;
}) {
  const [form, setForm] = useState<Form>({ clientId: clientId ?? null, ...EMPTY });
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({ clientId: clientId ?? null, ...EMPTY });
    setError(null);
    let alive = true;
    void Promise.all([
      clientId ? Promise.resolve([] as Client[]) : authFetch('http://127.0.0.1:3001/api/clients').then((r) => r.json() as Promise<Client[]>),
      authFetch('http://127.0.0.1:3001/api/services').then((r) => r.json() as Promise<ServiceRow[]>)
    ]).then(([clientRows, serviceRows]) => {
      if (!alive) return;
      setClients(clientRows);
      setServices(serviceRows);
    }).catch(() => { if (alive) setError('Não foi possível ler os clientes.'); });
    return () => { alive = false; };
  }, [open, clientId]);

  const clientServices = useMemo(
    () => services.filter((service) => service.clientId === form.clientId && service.status !== 'cancelled'),
    [services, form.clientId]
  );

  // Um cliente com um só serviço não obriga a escolher.
  useEffect(() => {
    if (clientServices.length === 1) setForm((current) => ({ ...current, serviceId: String(clientServices[0].id) }));
  }, [clientServices]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.clientId) { setError('Escolha o cliente.'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await ticketsRequest<TicketDetail>('', {
        method: 'POST',
        body: { ...form, serviceId: form.serviceId ? Number(form.serviceId) : null }
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível abrir o pedido.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} eyebrow="Assistência" title="Novo pedido" size="md"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="new-ticket-form" loading={saving}>Abrir pedido</Button>
        </>
      )}>
      <form id="new-ticket-form" className="client-form" onSubmit={submit}>
        {!clientId && (
          <label className="field">
            <span className="field-label">Cliente</span>
            <Combobox options={clients} value={form.clientId}
              onChange={(next) => setForm({ ...form, clientId: next == null ? null : Number(next), serviceId: '' })}
              rowKey={(client) => client.id} rowCode={(client) => client.clientCode} rowLabel={(client) => client.fullName}
              placeholder="Selecionar cliente..." ariaLabel="Cliente" />
          </label>
        )}
        <Select label="Serviço" value={form.serviceId} onChange={(event) => setForm({ ...form, serviceId: event.target.value })}>
          <option value="">{clientServices.length ? 'Sem serviço específico' : 'O cliente não tem serviços'}</option>
          {clientServices.map((service) => (
            <option key={service.id} value={service.id}>{service.planName ?? 'Sem plano'} · nº {service.id}</option>
          ))}
        </Select>
        <Field label="Assunto" value={form.subject} maxLength={140} required
          onChange={(event) => setForm({ ...form, subject: event.target.value })} placeholder="Ex.: sem internet desde ontem" />
        <Select label="Categoria" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as TicketCategory })}>
          {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Select label="Chegou por" value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as TicketChannel })}>
          {Object.entries(CHANNEL_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Select label="Prioridade" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as TicketPriority })}>
          {Object.entries(PRIORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Textarea label="O que o cliente disse" rows={3} required maxLength={4000} value={form.note}
          onChange={(event) => setForm({ ...form, note: event.target.value })} />
        {error && <Message tone="error">{error}</Message>}
      </form>
    </Dialog>
  );
}
