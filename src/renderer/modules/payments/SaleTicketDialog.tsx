import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, Field, Message, Select, Textarea } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';
import type { ArticleRow, StockCatalogRow, StockSummary } from '../../types';
import { AccountSelect } from '../treasury/AccountSelect';
import type { PaymentMethod } from './PaymentDetailDialog';
import './SaleTicketDialog.css';
import { centavosToEscudos, escudosToCentavos } from '../../../shared/money';

const API = 'http://127.0.0.1:3001/api';
const today = () => new Date().toISOString().slice(0, 10);
type Line = { key: string; catalogId: string; articleId: string; description: string; quantity: string; price: string; serials: string };
const emptyLine = (): Line => ({ key: crypto.randomUUID(), catalogId: '', articleId: '', description: '', quantity: '1', price: '', serials: '' });
const serialNumbers = (line: Line) => line.serials.split(/\r?\n/).map((serial) => serial.trim()).filter(Boolean);

export function SaleTicketDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (paymentId: number) => void;
}) {
  const [catalog, setCatalog] = useState<StockCatalogRow[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [method, setMethod] = useState<PaymentMethod>('numerario');
  const [accountId, setAccountId] = useState('');
  const [issuedOn, setIssuedOn] = useState(today());
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const busy = useRef(false);
  const request = useRef<{ key: string; body: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLines([emptyLine()]); setMethod('numerario'); setAccountId('');
    setIssuedOn(today()); setNotes(''); setError(''); setUncertain(false);
    request.current = null; setCatalog([]); setCatalogError(false); setCatalogSearch('');
    let alive = true;
    authFetch(`${API}/stock/summary`).then(async (response) => {
      if (!response.ok) throw new Error('catalog');
      const summary = await response.json() as StockSummary;
      if (alive) setCatalog(summary.rows.filter((item) => item.active));
    }).catch(() => { if (alive) setCatalogError(true); });
    // Sem artigos o talão continua a emitir: a linha livre cria-os.
    setArticles([]);
    authFetch(`${API}/articles`).then(async (response) => {
      if (response.ok && alive) setArticles((await response.json() as ArticleRow[]).filter((row) => row.active));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [open]);

  const requestedStock = new Map<number, number>();
  for (const line of lines) {
    if (line.catalogId) requestedStock.set(Number(line.catalogId), (requestedStock.get(Number(line.catalogId)) || 0) + Number(line.quantity));
  }
  const lineErrors = lines.map((line) => {
    const quantity = Number(line.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1000000) return 'A quantidade deve ser um inteiro entre 1 e 1 000 000.';
    if (!Number.isFinite(Number(line.price)) || Number(line.price) <= 0) return 'Indique um preço unitário positivo.';
    if (!line.catalogId && !line.articleId && !line.description.trim()) return 'Indique a descrição desta linha.';
    const item = catalog.find((row) => row.id === Number(line.catalogId));
    if (line.catalogId && !item) return 'Escolha um artigo ativo do catálogo.';
    if (item && (requestedStock.get(item.id) || 0) > item.stockTotal) return `Stock disponível: ${item.stockTotal}. A quantidade total deste produto excede o stock.`;
    if (item?.isSerialized) {
      const serials = serialNumbers(line);
      if (serials.length !== quantity) return `Indique ${quantity} número(s) de série, um por linha.`;
      if (new Set(serials.map((serial) => serial.toLowerCase())).size !== serials.length) return 'Os números de série não podem repetir-se.';
    }
    return '';
  });
  const allSerials = lines.flatMap((line) => catalog.find((row) => row.id === Number(line.catalogId))?.isSerialized ? serialNumbers(line) : []);
  const duplicateSerial = new Set(allSerials.map((serial) => serial.toLowerCase())).size !== allSerials.length;
  const totalCentavos = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * escudosToCentavos(Number(line.price) || 0), 0);
  const total = centavosToEscudos(totalCentavos);
  const valid = lineErrors.every((value) => !value) && !duplicateSerial && Number.isSafeInteger(totalCentavos) && totalCentavos > 0 && Boolean(accountId) && Boolean(issuedOn) && issuedOn <= today();
  const locked = submitting || uncertain;

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  }
  function close() { if (!busy.current && !request.current) onClose(); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || (!request.current && !valid)) return;
    busy.current = true; setSubmitting(true); setError('');
    if (!request.current) {
      const key = crypto.randomUUID();
      request.current = { key, body: JSON.stringify({ requestKey: key, lines: lines.map((line) => ({
        ...(line.catalogId ? { catalogId: Number(line.catalogId) } : line.articleId ? { articleId: Number(line.articleId) } : { description: line.description.trim() }),
        quantity: Number(line.quantity), unitPriceCve: Number(line.price),
        ...(catalog.find((row) => row.id === Number(line.catalogId))?.isSerialized ? { serialNumbers: serialNumbers(line) } : {})
      })), paymentMethod: method, accountId: Number(accountId), issuedOn, notes: notes.trim() || undefined }) };
    }
    try {
      const response = await authFetch(`${API}/payments/sale-tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.current.body });
      const result = await response.json() as { paymentId?: number; error?: string };
      if (!response.ok) {
        if (response.status < 500) { request.current = null; setUncertain(false); }
        else setUncertain(true);
        setError(result.error || 'Não foi possível emitir o talão.'); return;
      }
      if (!result.paymentId) throw new Error('Resposta incompleta');
      request.current = null; setUncertain(false); onCreated(result.paymentId);
    } catch {
      setUncertain(true);
      setError('Não foi possível confirmar a emissão. Tente novamente: o mesmo pedido será recuperado sem duplicar a venda.');
    } finally { busy.current = false; setSubmitting(false); }
  }

  return <Dialog open={open} onClose={close} title="Novo talão de venda" eyebrow="Pagamentos" size="lg" closeOnBackdrop={!locked} actions={<>
    <Button variant="secondary" onClick={close} disabled={locked}>Cancelar</Button>
    <Button type="submit" form="sale-ticket-form" loading={submitting} disabled={submitting || (!uncertain && !valid)}>{uncertain ? 'Confirmar emissão' : `Emitir talão · ${formatCve(Number.isFinite(total) ? total : 0)}`}</Button>
  </>}>
    <form id="sale-ticket-form" className="client-form sale-ticket-form" onSubmit={submit}>
      <div className="sale-ticket-recipient"><div><span className="field-label">Destinatário</span><strong>Cliente Indiferenciado</strong></div><Badge tone="success">Pago na emissão</Badge></div>
      <p className="sale-ticket-hint">Venda avulsa com pagamento integral. Os produtos do stock saem do armazém ao emitir; cada linha livre fica guardada com código em Stock → Artigos e serviços.</p>
      {error && <Message tone="error">{error}</Message>}
      {catalogError && <Message tone="error">Não foi possível carregar o catálogo. Pode emitir linhas livres.</Message>}
      <div className="service-items-builder"><div className="service-items-group">
        <p className="service-items-group-title">Artigos e serviços</p>
        <Field label="Pesquisar produtos" type="search" placeholder="Marca ou modelo" value={catalogSearch} disabled={locked} onChange={(event) => setCatalogSearch(event.target.value)} />
        {lines.map((line, index) => <div className="sale-ticket-line" key={line.key}>
          <div className="sale-ticket-line-heading"><strong>Linha {index + 1}</strong><Button variant="ghost" size="sm" leadingIcon={<Trash2 size={15} aria-hidden />} disabled={locked || lines.length === 1} onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}>Remover</Button></div>
          <Select label={`Artigo ${index + 1}`} value={line.articleId ? `a:${line.articleId}` : line.catalogId} disabled={locked} onChange={(event) => {
            const value = event.target.value;
            if (value.startsWith('a:')) {
              const article = articles.find((row) => row.id === Number(value.slice(2)));
              updateLine(line.key, { catalogId: '', articleId: value.slice(2), description: '', serials: '', price: article?.unitPriceCve ? String(article.unitPriceCve) : '' });
              return;
            }
            const item = catalog.find((row) => row.id === Number(value));
            updateLine(line.key, { catalogId: value, articleId: '', description: '', serials: '', price: item ? String(item.sellingPriceCve || '') : '' });
          }}><option value="">Linha livre</option>{articles.length > 0 && <optgroup label="Artigos e serviços">{articles.map((row) => <option key={`a${row.id}`} value={`a:${row.id}`}>{row.code} · {row.name}</option>)}</optgroup>}<optgroup label="Stock">{catalog.filter((item) => String(item.id) === line.catalogId || [item.brand, item.model].filter(Boolean).join(' ').toLocaleLowerCase('pt').includes(catalogSearch.trim().toLocaleLowerCase('pt'))).map((item) => <option key={item.id} value={item.id}>{item.code ? `${item.code} · ` : ''}{[item.brand, item.model].filter(Boolean).join(' ')} · {item.stockTotal} em stock</option>)}</optgroup></Select>
          {!line.catalogId && !line.articleId && <Field label={`Descrição ${index + 1}`} required maxLength={200} value={line.description} disabled={locked} onChange={(event) => updateLine(line.key, { description: event.target.value })} />}
          <div className="sale-ticket-line-pricing"><Field label={`Quantidade ${index + 1}`} type="number" required min={1} step={1} value={line.quantity} disabled={locked} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} />
          <Field label={`Preço unitário CVE ${index + 1}`} type="number" required min="0.01" step="0.01" value={line.price} disabled={locked} onChange={(event) => updateLine(line.key, { price: event.target.value })} /></div>
          {Boolean(catalog.find((row) => row.id === Number(line.catalogId))?.isSerialized) && <Textarea label={`Números de série ${index + 1}`} required rows={3} value={line.serials} disabled={locked} hint="Um número de série por unidade, um por linha." onChange={(event) => updateLine(line.key, { serials: event.target.value })} />}
          {lineErrors[index] && <p className="field-error">{lineErrors[index]}</p>}
        </div>)}
        {duplicateSerial && <Message tone="error">Um número de série foi repetido entre linhas.</Message>}
        <div className="form-actions manual-invoice-total"><Button variant="secondary" size="sm" leadingIcon={<Plus size={16} aria-hidden />} disabled={locked || lines.length >= 20} onClick={() => setLines((current) => [...current, emptyLine()])}>Acrescentar linha</Button><strong>Total {formatCve(Number.isFinite(total) ? total : 0)}</strong></div>
      </div></div>
      <Select label="Método de pagamento" value={method} disabled={locked} onChange={(event) => { setMethod(event.target.value as PaymentMethod); setAccountId(''); }}><option value="numerario">Numerário</option><option value="transferencia">Transferência</option><option value="outro">Outro</option></Select>
      <AccountSelect purpose={method} value={accountId} onChange={setAccountId} disabled={locked} />
      <Field label="Data de emissão" type="date" required max={today()} value={issuedOn} disabled={locked} onChange={(event) => setIssuedOn(event.target.value)} />
      <Textarea label="Observações" rows={2} maxLength={500} value={notes} disabled={locked} onChange={(event) => setNotes(event.target.value)} />
    </form>
  </Dialog>;
}
