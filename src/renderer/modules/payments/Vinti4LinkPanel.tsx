import { useState } from 'react';
import { Copy, ExternalLink, Link2 } from 'lucide-react';
import { Button, Field, Message } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';

export const VINTI4_PORTAL_URL = 'https://comerciante.vinti4.cv';

export type Vinti4LinkInfo = {
  url: string;
  amountCve: number;
  /** O valor do link ainda é o saldo; senão não segue nos avisos. */
  current: boolean;
};

/** O que a ficha da fatura sabe do Vinti4; `enabled` = ligado e com conta de destino. */
export type Vinti4State = {
  enabled: boolean;
  accountId: number | null;
  link: Vinti4LinkInfo | null;
};

type Vinti4LinkPanelProps = {
  paymentId: number;
  balanceCve: number;
  link: Vinti4LinkInfo | null;
  disabled: boolean;
  /** O link mudou: a ficha volta a pedir o estado. */
  onChanged: () => void;
};

async function openPortal() {
  const opened = await window.ispm?.openExternal?.(VINTI4_PORTAL_URL);
  // Sem Electron (dev no browser) o `window.open` cobre o caso.
  if (opened === undefined) window.open(VINTI4_PORTAL_URL, '_blank', 'noopener');
}

/**
 * Vinti4 por EasyLink (ADR 0019): o link cria-se no Portal do Comerciante e
 * cola-se aqui. O SISP não avisa o ISPM do pagamento: o recibo regista-se em
 * baixo, quando o portal mostrar o link como pago.
 */
export function Vinti4LinkPanel({ paymentId, balanceCve, link, disabled, onChanged }: Vinti4LinkPanelProps) {
  const [draft, setDraft] = useState('');
  // Sem link, o campo aparece sozinho; com link, só ao pedir "Substituir".
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const endpoint = `http://127.0.0.1:3001/api/payments/${paymentId}/vinti4-link`;

  async function send(init: RequestInit) {
    setBusy(true);
    setError('');
    try {
      const response = await authFetch(endpoint, init);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error || 'Nao foi possivel guardar o link.');
        return false;
      }
      onChanged();
      return true;
    } catch {
      setError('Falha de rede ao guardar o link.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const saved = await send({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: draft }) });
    if (saved) { setEditing(false); setDraft(''); }
  }

  async function remove() {
    if (await send({ method: 'DELETE' })) setEditing(false);
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('Nao foi possivel copiar: selecione o link e copie a mao.');
    }
  }

  return (
    <div className="vinti4-link-panel">
      {link && !editing ? (
        <>
          <Field label={`Link Vinti4 · ${formatCve(link.amountCve)}`} value={link.url} readOnly onFocus={(event) => event.target.select()} />
          {!link.current && (
            <Message tone="warn">
              O saldo é agora {formatCve(balanceCve)}: este link cobra {formatCve(link.amountCve)} e deixou de seguir nos avisos. Crie outro no portal e substitua-o.
            </Message>
          )}
        </>
      ) : (
        <>
          <Message>
            Crie no Portal do Comerciante um EasyLink de {formatCve(balanceCve)} e cole-o aqui: passa a seguir nos avisos de WhatsApp e SMS desta fatura.
          </Message>
          <Field
            label="Link EasyLink"
            type="url"
            inputMode="url"
            placeholder="https://…vinti4…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={disabled || busy}
          />
        </>
      )}
      {error && <Message tone="error">{error}</Message>}
      <div className="inline-actions">
        {link && !editing ? (
          <>
            <Button leadingIcon={<Copy size={16} aria-hidden />} onClick={() => void copyLink(link.url)}>
              {copied ? 'Link copiado' : 'Copiar link'}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={disabled || busy}>Substituir</Button>
            <Button variant="secondary" onClick={() => void remove()} loading={busy} disabled={disabled || busy}>Retirar</Button>
          </>
        ) : (
          <>
            <Button leadingIcon={<Link2 size={16} aria-hidden />} onClick={() => void save()} loading={busy} disabled={disabled || busy || !draft.trim()}>
              Guardar link
            </Button>
            {link && <Button variant="secondary" onClick={() => { setEditing(false); setDraft(''); setError(''); }} disabled={busy}>Manter o atual</Button>}
          </>
        )}
        <Button variant="secondary" leadingIcon={<ExternalLink size={16} aria-hidden />} onClick={() => void openPortal()}>
          Portal do Comerciante
        </Button>
      </div>
    </div>
  );
}
