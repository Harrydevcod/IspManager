import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2 } from 'lucide-react';
import { Badge, Button, Message } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatPtDateTime } from '../../lib/format';

type Link = { id: string; expiresAt: number; publishedAt: string | null; revokedAt: string | null };
const api = 'http://127.0.0.1:3001/api';

/** Links da área do cliente: um instantâneo cifrado da conta, válido 24 h, servido pelo relé. */
export function CustomerPortal({ clientId }: { clientId: number }) {
  const [links, setLinks] = useState<Link[]>([]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await authFetch(`${api}/clients/${clientId}/portal-links`);
      if (!response.ok) throw new Error();
      setLinks(await response.json() as Link[]);
    } catch { setError('Não foi possível carregar os links.'); }
  }, [clientId]);
  useEffect(() => { setUrl(''); setError(''); void load(); }, [load]);
  async function create() {
    setBusy(true); setError(''); setUrl(''); setCopied(false);
    try {
      const response = await authFetch(`${api}/clients/${clientId}/portal-links`, { method: 'POST' });
      if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error || 'Não foi possível criar o link.'); }
      const result = await response.json() as { url: string };
      setUrl(result.url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível criar o link.'); }
    finally { setBusy(false); await load(); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try {
      const response = await authFetch(`${api}/clients/${clientId}/portal-links/${id}`, { method: 'DELETE' });
      if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error || 'Não foi possível revogar o link.'); }
      if (url.includes(`/customer/${id}#`)) setUrl('');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível revogar o link.'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); }
    catch { setError('Não foi possível copiar. Selecione o link e copie.'); }
  }
  const active = links.filter((link) => !link.revokedAt && link.expiresAt > Date.now());
  return <section className="client-profitability customer-portal" aria-label="Área do cliente">
    <header>
      <strong>Área do cliente</strong>
      <Button variant="secondary" size="sm" leadingIcon={<Link2 size={14} aria-hidden />} loading={busy} onClick={() => void create()}>Criar link</Button>
    </header>
    {url && <div className="customer-portal-new">
      {/* O link leva a chave no fragmento: só existe aqui, não se volta a mostrar. */}
      <input readOnly aria-label="Link da área do cliente" value={url} onFocus={(event) => event.currentTarget.select()} />
      <Button variant="secondary" size="sm" leadingIcon={<Copy size={14} aria-hidden />} onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar'}</Button>
    </div>}
    {error && <Message tone="error">{error}</Message>}
    {active.length > 0 && <ul className="customer-portal-links">
      {active.map((link) => <li key={link.id}>
        <Badge tone={link.publishedAt ? 'success' : 'warn'}>{link.publishedAt ? 'Ativo' : 'Por confirmar'}</Badge>
        <span className="customer-portal-until">até {formatPtDateTime(new Date(link.expiresAt).toISOString())}</span>
        <Button variant="critical" size="sm" disabled={busy} onClick={() => void revoke(link.id)}>Revogar</Button>
      </li>)}
    </ul>}
  </section>;
}
