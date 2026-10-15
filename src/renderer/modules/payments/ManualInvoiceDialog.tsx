import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Combobox, Dialog, Field, Message, Select, Textarea, Toggle } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';
import type { ArticleRow, Client, ServiceRow } from '../../types';

const API = 'http://127.0.0.1:3001/api';
const MAX_LINES = 20;
const NIF_PATTERN = /^[12]\d{8}$/;

/** `amount` é o preço unitário; o valor da linha é quantidade × preço. */
type Line = { description: string; quantity: string; amount: string };

type ManualInvoiceDialogProps = {
  open: boolean;
  onClose: () => void;
  /** A fatura existe: a lista recarrega e a ficha dela abre. */
  onCreated: (paymentId: number, stripeWarning?: string) => void;
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const emptyLine = (): Line => ({ description: '', quantity: '1', amount: '' });
const lineTotal = (line: Line) => (Number(line.quantity) > 0 && Number(line.amount) > 0 ? Math.round(Number(line.quantity) * Number(line.amount) * 100) / 100 : 0);

/**
 * Fatura manual: o que não é mensalidade. O destinatário é um cliente da lista
 * ou alguém novo, que fica registado sem serviço no mesmo passo.
 */
export function ManualInvoiceDialog({ open, onClose, onCreated }: ManualInvoiceDialogProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [articles, setArticles] = useState<ArticleRow[]>([]);
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
    void load<ArticleRow[]>('/articles', (rows) => setArticles(rows.filter((row) => row.active)));
    void load<{ enabled: boolean }>('/stripe/status', (status) => setStripeReady(Boolean(status.enabled)));
    return () => { alive = false; };
  }, [open]);

  const clientServices = useMemo(
    () => services.filter((service) => service.clientId === clientId && service.status !== 'cancelled'),
    [services, clientId]
  );

  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const linesValid = lines.every((line) => line.description.trim() && lineTotal(line) > 0);
  const nifValid = !recipient.nif || NIF_PATTERN.test(recipient.nif);
  const recipientValid = isNewRecipient ? Boolean(recipient.fullName.trim()) && nifValid : clientId !== null;
  const canUseStripe = !isNewRecipient && Boolean(clients.find((client) => client.id === clientId)?.email?.trim());
  const canSubmit = recipientValid && linesValid && Boolean(invoiceDate) && !submitting;

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  // Escolher um artigo da lista traz o preço dele. O servidor liga a linha ao artigo
  // com o mesmo nome; um nome novo fica guardado como serviço com código.
  function pickDescription(index: number, description: string) {
    const article = articles.find((row) => row.name.toLocaleLowerCase('pt') === description.trim().toLocaleLowerCase('pt'));
    updateLine(index, article && !lines[index].amount && article.unitPriceCve > 0
      ? { description, amount: String(article.unitPriceCve) }
      : { description });
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
          lines: lines.map((line) => ({ description: line.description, quantity: Number(line.quantity), unitPriceCve: Number(line.amount) })),
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
      let stripeWarning: string | undefined;
      if (withStripe && canUseStripe) {
        try {
          const linkResponse = await authFetch(`${API}/payments/${body.paymentId}/stripe-link`, { method: 'POST' });
          if (!linkResponse.ok) {
            const linkBody = await linkResponse.json().catch(() => ({})) as { error?: string };
            stripeWarning = `Fatura emitida, mas o link Stripe não foi criado. ${linkBody.error || 'Não foi possível contactar o Stripe.'} Tente gerar o link na ficha da fatura.`;
          }
        } catch {
          stripeWarning = 'Fatura emitida, mas houve uma falha de rede ao criar o link Stripe. Tente gerar o link na ficha da fatura.';
        }
      }
      onCreated(body.paymentId, stripeWarning);
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
          disabled={submitting}
          onChange={(event) => { setIsNewRecipient(event.target.checked); setServiceId(''); setWithStripe(false); }}
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
                options={clients.filter((client) => !client.systemKind)}
                value={clientId}
                onChange={(next) => { setClientId(next === null ? null : Number(next)); setServiceId(''); setWithStripe(false); }}
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
            <datalist id="manual-invoice-articles">
              {articles.map((row) => <option key={row.id} value={row.name}>{row.code}</option>)}
            </datalist>
            {lines.map((line, index) => (
              <div key={index} className="service-item-draft manual-invoice-line">
                <Field label="Descrição" required maxLength={200} value={line.description} list="manual-invoice-articles"
                  placeholder="Deslocação técnica" onChange={(event) => pickDescription(index, event.target.value)} disabled={submitting} />
                <Field label="Qtd." required type="number" min="0.001" step="0.001" value={line.quantity}
                  onChange={(event) => updateLine(index, { quantity: event.target.value })} disabled={submitting} />
                <Field label="Preço unit. CVE" required type="number" min="0.01" step="0.01" value={line.amount}
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
            description={canUseStripe
              ? 'A fatura fica com um link para o cliente pagar por cartão. Pode sempre ser paga em numerário ou transferência.'
              : 'O Stripe exige um email. Registe o email em Clientes e gere o link na ficha da fatura depois de a emitir.'}
            checked={withStripe}
            disabled={submitting || !canUseStripe}
            onChange={(event) => setWithStripe(event.target.checked)}
          />
        )}
      </form>
    </Dialog>
  );
}
