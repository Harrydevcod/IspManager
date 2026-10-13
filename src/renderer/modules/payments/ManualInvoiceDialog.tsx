import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Combobox, Dialog, Field, Message, Select, Textarea, Toggle } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';
import type { Client, ServiceRow } from '../../types';

const API = 'http://127.0.0.1:3001/api';
const MAX_LINES = 20;
const NIF_PATTERN = /^[12]\d{8}$/;

type Line = { description: string; amount: string };

type ManualInvoiceDialogProps = {
  open: boolean;
  onClose: () => void;
  /** A fatura existe: a lista recarrega e a ficha dela abre. */
  onCreated: (paymentId: number) => void;
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const emptyLine = (): Line => ({ description: '', amount: '' });

/**
 * Fatura manual: o que não é mensalidade. O destinatário é um cliente da lista
 * ou alguém novo, que fica registado sem serviço no mesmo passo.
 */
export function ManualInvoiceDialog({ open, onClose, onCreated }: ManualInvoiceDialogProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [stripeReady, setStripeReady] = useState(false);

  const [isNewRecipient, setIsNewRecipient] = useState(false);
  const [clientId, setClientId] = useState<number | null>(null);
  const [recipient, setRecipient] = useState({ fullName: '', nif: '', phone: '', address: '' });
  const [serviceId, setServiceId] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [withStripe, setWithStripe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Cada abertura começa em branco e com as listas frescas: um cliente criado
  // pela fatura anterior já tem de aparecer.
  useEffect(() => {
    if (!open) return;
    setIsNewRecipient(false);
    setClientId(null);
    setRecipient({ fullName: '', nif: '', phone: '', address: '' });
    setServiceId('');
    setLines([emptyLine()]);
    setInvoiceDate(todayIso());
    setDueDate('');
    setNotes('');
    setWithStripe(false);
    setError('');

    let alive = true;
    const load = async <T,>(path: string, apply: (value: T) => void) => {
      try {
        const response = await authFetch(`${API}${path}`);
        if (alive && response.ok) apply(await response.json() as T);
      } catch {
        // Sem lista o formulário continua a servir para um destinatário novo.
      }
    };
    void load<Client[]>('/clients', setClients);
    void load<ServiceRow[]>('/services', setServices);
    void load<{ enabled: boolean }>('/stripe/status', (status) => setStripeReady(Boolean(status.enabled)));
    return () => { alive = false; };
  }, [open]);

  const clientServices = useMemo(
    () => services.filter((service) => service.clientId === clientId && service.status !== 'cancelled'),
    [services, clientId]
  );

  const total = lines.reduce((sum, line) => sum + (Number(line.amount) > 0 ? Number(line.amount) : 0), 0);
  const linesValid = lines.every((line) => line.description.trim() && Number(line.amount) > 0);
  const nifValid = !recipient.nif || NIF_PATTERN.test(recipient.nif);
  const recipientValid = isNewRecipient ? Boolean(recipient.fullName.trim()) && nifValid : clientId !== null;
  const canSubmit = recipientValid && linesValid && Boolean(invoiceDate) && !submitting;

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await authFetch(`${API}/payments/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(isNewRecipient
            ? { newClient: { fullName: recipient.fullName, nif: recipient.nif || null, phone: recipient.phone || null, address: recipient.address || null } }
            : { clientId, serviceId: serviceId ? Number(serviceId) : null }),
          lines: lines.map((line) => ({ description: line.description, amountCve: Number(line.amount) })),
          invoiceDate,
          dueDate: dueDate || null,
          notes: notes || null
        })
      });
      const body = await response.json().catch(() => ({})) as { paymentId?: number; error?: string };
      if (!response.ok || !body.paymentId) {
        setError(body.error || 'Nao foi possivel emitir a fatura.');
        return;
      }
      // Fatura primeiro, link depois: se o Stripe falhar a fatura já existe e o
      // link pede-se na ficha dela, que abre a seguir.
      if (withStripe) {
        await authFetch(`${API}/payments/${body.paymentId}/stripe-link`, { method: 'POST' }).catch(() => undefined);
      }
      onCreated(body.paymentId);
    } catch {
      setError('Falha de rede ao emitir a fatura.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Pagamentos"
      title="Nova fatura"
      size="lg"
      closeOnBackdrop={!submitting}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="manual-invoice-form" disabled={!canSubmit} loading={submitting}>
            {submitting ? 'A emitir...' : `Emitir fatura${total > 0 ? ` · ${formatCve(total)}` : ''}`}
          </Button>
        </>
      }
    >
      <form id="manual-invoice-form" className="client-form manual-invoice-form" onSubmit={submit}>
        {error && <Message tone="error">{error}</Message>}

        <Toggle
          title="Destinatário novo"
          description="Para quem ainda não é cliente. Fica registado em Clientes, sem serviço, e da próxima vez já aparece na lista."
          checked={isNewRecipient}
          onChange={(event) => { setIsNewRecipient(event.target.checked); setServiceId(''); }}
        />

        {isNewRecipient ? (
          <>
            <Field label="Nome" required maxLength={160} value={recipient.fullName}
              onChange={(event) => setRecipient((r) => ({ ...r, fullName: event.target.value }))} disabled={submitting} />
            <Field label="NIF" inputMode="numeric" maxLength={9} value={recipient.nif}
              onChange={(event) => setRecipient((r) => ({ ...r, nif: event.target.value.replace(/\D/g, '') }))}
              error={nifValid ? undefined : 'O NIF tem 9 dígitos e começa por 1 ou 2.'} disabled={submitting} />
            <Field label="Telefone" type="tel" inputMode="tel" maxLength={40} value={recipient.phone}
              onChange={(event) => setRecipient((r) => ({ ...r, phone: event.target.value }))} disabled={submitting} />
            <Field label="Morada" maxLength={240} value={recipient.address}
              onChange={(event) => setRecipient((r) => ({ ...r, address: event.target.value }))} disabled={submitting} />
          </>
        ) : (
          <>
            <div className="field">
              <span className="field-label">Cliente</span>
              <Combobox
                ariaLabel="Cliente"
                options={clients}
                value={clientId}
                onChange={(next) => { setClientId(next === null ? null : Number(next)); setServiceId(''); }}
                rowKey={(client) => client.id}
                rowCode={(client) => client.clientCode}
                rowLabel={(client) => client.fullName}
                rowHint={(client) => client.nif || undefined}
                placeholder="Escolher cliente..."
                disabled={submitting}
              />
            </div>
            <Select
              label="Serviço"
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              disabled={submitting || clientId === null}
              hint={serviceId ? 'Conta para o corte por dívida deste serviço.' : 'Sem serviço, a fatura nunca corta a Internet.'}
            >
              <option value="">Sem serviço</option>
              {clientServices.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.planName || 'Serviço sem plano'} · {formatCve(service.monthlyValueCve)}{service.pppoeUsername ? ` · ${service.pppoeUsername}` : ''}
                </option>
              ))}
            </Select>
          </>
        )}

        <div className="service-items-builder">
          <div className="service-items-group">
            <p className="service-items-group-title">Linhas da fatura</p>
            {lines.map((line, index) => (
              <div key={index} className="service-item-draft manual-invoice-line">
                <Field label="Descrição" required maxLength={200} value={line.description}
                  placeholder="Deslocação técnica" onChange={(event) => updateLine(index, { description: event.target.value })} disabled={submitting} />
                <Field label="Valor CVE" required type="number" min="0.01" step="0.01" value={line.amount}
                  onChange={(event) => updateLine(index, { amount: event.target.value })} disabled={submitting} />
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Trash2 size={16} aria-hidden />}
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                  disabled={submitting || lines.length === 1}
                  title="Remover esta linha"
                >
                  Remover
                </Button>
              </div>
            ))}
            <div className="form-actions manual-invoice-total">
              <Button variant="secondary" size="sm" leadingIcon={<Plus size={16} aria-hidden />}
                onClick={() => setLines((current) => [...current, emptyLine()])} disabled={submitting || lines.length >= MAX_LINES}>
                Acrescentar linha
              </Button>
              <strong>Total {formatCve(total)}</strong>
            </div>
          </div>
        </div>

        <Field label="Data de emissão" type="date" required max={todayIso()} value={invoiceDate}
          onChange={(event) => setInvoiceDate(event.target.value)} disabled={submitting} />
        <Field label="Vencimento" type="date" min={invoiceDate} value={dueDate}
          onChange={(event) => setDueDate(event.target.value)} disabled={submitting}
          hint="Vazio = 30 dias depois da emissão." />
        <Textarea label="Observações" rows={2} maxLength={500} value={notes}
          onChange={(event) => setNotes(event.target.value)} disabled={submitting} />
        {stripeReady && (
          <Toggle
            title="Gerar link de pagamento Stripe"
            description="A fatura fica com um link para o cliente pagar por cartão. Pode sempre ser paga em numerário ou transferência."
            checked={withStripe}
            onChange={(event) => setWithStripe(event.target.checked)}
          />
        )}
      </form>
    </Dialog>
  );
}
