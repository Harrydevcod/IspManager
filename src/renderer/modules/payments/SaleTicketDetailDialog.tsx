import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, Printer, X } from 'lucide-react';
import { Badge, Button, Dialog, ErrorRetry, Field, Message, Select, Textarea, Toggle } from '../../components';
import { authFetch, useAuth } from '../../lib/auth';
import { downloadAuthenticated, printAuthenticated, useAuthenticatedObjectUrl } from '../../lib/download';
import { formatCve, formatPtDate } from '../../lib/format';
import type { PaymentRow } from '../../types';
import { METHOD_LABELS } from './ReceiptsSection';
import './SaleTicketDialog.css';

const API = 'http://127.0.0.1:3001/api/payments';
type SaleTicket = {
  paymentId: number; documentNumber: string; amountCve: number; status: string;
  paymentMethod: string; accountId: number | null; issuedOn: string; notes: string | null; clientName: string;
  lines: Array<{ description: string; quantity: number; unitPriceCve: number; totalCve: number; catalogId: number | null; serialNumbers: string[] }>;
};

export function SaleTicketDetailDialog({ payment, onClose, onCancelled }: {
  payment: PaymentRow; onClose: () => void; onCancelled: () => void;
}) {
  const { hasRole } = useAuth();
  const [ticket, setTicket] = useState<SaleTicket | null>(null);
  const [loadError, setLoadError] = useState('');
  const [format, setFormat] = useState<'a4' | 'a5' | '80mm'>('a5');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [returned, setReturned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const documentLock = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError('');
    try {
      const response = await authFetch(`${API}/${payment.id}/sale-ticket`, { signal });
      if (!response.ok) throw new Error('Não foi possível carregar o talão.');
      const body = await response.json() as SaleTicket;
      if (!signal?.aborted) setTicket(body);
    } catch {
      if (!signal?.aborted) setLoadError('Não foi possível carregar o talão.');
    }
  }, [payment.id]);
  useEffect(() => {
    const controller = new AbortController();
    setTicket(null); void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const pdfUrl = `${API}/${payment.id}/sale-ticket.pdf?format=${format}`;
  const cancelled = ticket?.status === 'cancelled' || payment.status === 'cancelled';
  const preview = useAuthenticatedObjectUrl(ticket ? `${pdfUrl}&state=${cancelled ? 'cancelled' : 'paid'}` : null);

  async function documentAction(kind: 'download' | 'print') {
    if (documentLock.current) return;
    documentLock.current = true; setDocumentBusy(true); setError('');
    try {
      if (kind === 'print') await printAuthenticated(pdfUrl);
      else await downloadAuthenticated(pdfUrl, `${ticket?.documentNumber || 'TV'}-${format}.pdf`);
    } catch { setError('Não foi possível abrir o PDF. Tente novamente.'); }
    finally { documentLock.current = false; setDocumentBusy(false); }
  }
  function closeCancellation() {
    if (busy.current) return;
    setCancelOpen(false); setPassword(''); setReason(''); setReturned(false); setError('');
  }
  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !reason.trim() || !password || !returned || !hasRole('admin')) return;
    busy.current = true; setSubmitting(true); setError('');
    try {
      const response = await authFetch(`${API}/${payment.id}/sale-ticket/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), confirmPassword: password, productsReturned: true })
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || 'Não foi possível anular o talão.'); return; }
      setPassword(''); setCancelOpen(false); setTicket((current) => current ? { ...current, status: 'cancelled' } : current);
      onCancelled();
    } catch { setError('Não foi possível confirmar a anulação. Tente novamente.'); }
    finally { busy.current = false; setSubmitting(false); }
  }

  return <>
    <Dialog open onClose={() => { if (!busy.current) onClose(); }} title={ticket?.documentNumber || payment.invoiceNumber || 'Talão de venda'} eyebrow="Talão de venda" size="lg" actions={<>
      {hasRole('admin') && !cancelled && ticket && <Button variant="danger" leadingIcon={<X size={15} aria-hidden />} onClick={() => { setError(''); setCancelOpen(true); }}>Anular talão</Button>}
      <Button variant="secondary" leadingIcon={<Download size={15} aria-hidden />} disabled={!ticket || documentBusy} onClick={() => void documentAction('download')}>Guardar PDF</Button>
      <Button leadingIcon={<Printer size={15} aria-hidden />} disabled={!ticket || documentBusy} onClick={() => void documentAction('print')}>Imprimir</Button>
    </>}>
      {loadError ? <ErrorRetry message={loadError} onRetry={() => void load()} /> : !ticket ? <p>A carregar talão...</p> : <div className="client-form sale-ticket-detail">
        <div className="sale-ticket-recipient"><div><span className="field-label">Destinatário</span><strong>{ticket.clientName}</strong></div><Badge tone={cancelled ? 'neutral' : 'success'}>{cancelled ? 'Anulado' : 'Pago'}</Badge></div>
        <div className="client-detail"><dl><div><dt>Emissão</dt><dd>{formatPtDate(ticket.issuedOn)}</dd></div><div><dt>Pagamento</dt><dd>{METHOD_LABELS[ticket.paymentMethod] || ticket.paymentMethod}</dd></div><div><dt>Total</dt><dd>{formatCve(ticket.amountCve)}</dd></div></dl></div>
        {cancelled && <Message>Documento anulado. O histórico e o PDF permanecem disponíveis.</Message>}
        {error && !cancelOpen && <Message tone="error">{error}</Message>}
        <div className="sale-ticket-detail-lines">{ticket.lines.map((line, index) => <div key={index} className="sale-ticket-detail-line">
          <div className="sale-ticket-detail-line-heading"><strong>{line.description}</strong><b>{formatCve(line.totalCve)}</b></div>
          <small>{line.quantity} × {formatCve(line.unitPriceCve)}</small>
          {line.serialNumbers?.length > 0 && <small>Séries: {line.serialNumbers.join(', ')}</small>}
        </div>)}</div>
        {ticket.notes && <p>{ticket.notes}</p>}
        <Select label="Formato do PDF" value={format} disabled={documentBusy} onChange={(event) => setFormat(event.target.value as 'a4' | 'a5' | '80mm')}><option value="a5">A5</option><option value="a4">A4</option><option value="80mm">Talão 80 mm</option></Select>
        {preview.error ? <Message tone="error">Não foi possível carregar a pré-visualização. Pode tentar guardar ou imprimir o PDF.</Message> : preview.objectUrl ? <iframe className="pdf-dialog-frame" src={`${preview.objectUrl}#toolbar=0`} title={`Talão de venda ${ticket.documentNumber}`} /> : <p>A carregar PDF...</p>}
      </div>}
    </Dialog>
    <Dialog open={cancelOpen} onClose={closeCancellation} title="Anular talão de venda" eyebrow={ticket?.documentNumber} size="md" closeOnBackdrop={!submitting} actions={<>
      <Button variant="secondary" disabled={submitting} onClick={closeCancellation}>Voltar</Button>
      <Button variant="danger" type="submit" form="cancel-sale-ticket-form" loading={submitting} disabled={!reason.trim() || !password || !returned}>Confirmar anulação</Button>
    </>}>
      <form id="cancel-sale-ticket-form" className="client-form" onSubmit={cancel}>
        <Message>A anulação repõe os artigos no stock e estorna o recebimento na tesouraria. O documento permanece no histórico.</Message>
        {error && <Message tone="error">{error}</Message>}
        <Textarea label="Motivo da anulação" required maxLength={500} rows={3} value={reason} disabled={submitting} onChange={(event) => setReason(event.target.value)} />
        <Field label="A sua palavra-passe de administrador" type="password" autoComplete="current-password" required value={password} disabled={submitting} onChange={(event) => setPassword(event.target.value)} />
        <Toggle title="Confirmo a devolução dos produtos" description="Todos os artigos desta venda foram devolvidos e podem regressar ao stock." checked={returned} disabled={submitting} onChange={(event) => setReturned(event.target.checked)} />
      </form>
    </Dialog>
  </>;
}
