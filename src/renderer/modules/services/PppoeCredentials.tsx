import { Eye, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Message, useToast } from '../../components';
import { authFetch } from '../../lib/auth';

const API = 'http://127.0.0.1:3001/api/services';

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; body: T & { error?: string } }> {
  const response = await authFetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { ok: response.ok, body: await response.json().catch(() => ({})) as T & { error?: string } };
}

/** Dá utilizador e senha PPPoE a um serviço que ainda não os tem. */
export function CreatePppoeButton({ serviceId, clientName, onCreated }: { serviceId: number; clientName: string; onCreated: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    setOpen(false);
    setUsername('');
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await post<{ username?: string }>(`${serviceId}/pppoe`, { username: username.trim() || null });
      if (!result.ok) {
        setError(result.body.error ?? 'Não foi possível criar o utilizador PPPoE.');
        return;
      }
      toast(`Utilizador PPPoE ${result.body.username} criado. O router recebe-o na próxima sincronização.`, 'success');
      setOpen(false);
      setUsername('');
      setError(null);
      onCreated();
    } catch {
      setError('Falha de rede ao criar o utilizador PPPoE.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" leadingIcon={<Plus size={14} aria-hidden />} onClick={() => setOpen(true)}>
        Criar PPPoE
      </Button>
      <Dialog
        open={open}
        onClose={close}
        eyebrow="PPPoE"
        title={`Criar PPPoE de ${clientName}`}
        size="sm"
        closeOnBackdrop={!busy}
        actions={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancelar</Button>
            <Button type="submit" form="pppoe-create-form" loading={busy}>Criar PPPoE</Button>
          </>
        }
      >
        <form id="pppoe-create-form" className="client-form" onSubmit={submit}>
          <Message tone="neutral">
            A senha é gerada pelo ISPM e fica no cofre. O utilizador nasce no router na sincronização seguinte.
          </Message>
          <Field
            wide
            label="Utilizador PPPoE"
            maxLength={64}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            hint="Vazio: o nome sai do código do cliente."
            error={error ?? undefined}
          />
        </form>
      </Dialog>
    </>
  );
}

/**
 * Mostra a senha PPPoE de um serviço. É a única leitura de uma credencial na
 * aplicação, por isso pede a password do administrador outra vez; nada fica em
 * memória depois de fechar.
 */
export function RevealPppoePassword({ serviceId }: { serviceId: number }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState<{ username: string | null; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    setOpen(false);
    setPassword('');
    setRevealed(null);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) {
      setError('Confirme a sua password para ver a senha.');
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ username?: string | null; password?: string }>(`${serviceId}/pppoe-password/reveal`, { password });
      // A password nunca fica em memória depois de enviada.
      setPassword('');
      if (!result.ok || !result.body.password) {
        setError(result.body.error ?? 'Não foi possível ler a senha PPPoE.');
        return;
      }
      setError(null);
      setRevealed({ username: result.body.username ?? null, password: result.body.password });
    } catch {
      setError('Falha de rede ao ler a senha PPPoE.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" leadingIcon={<Eye size={14} aria-hidden />} onClick={() => setOpen(true)}>
        Mostrar
      </Button>
      <Dialog
        open={open}
        onClose={close}
        eyebrow="PPPoE"
        title="Senha PPPoE"
        size="sm"
        closeOnBackdrop={!busy}
        actions={revealed
          ? <Button onClick={close}>Fechar</Button>
          : (
            <>
              <Button variant="secondary" onClick={close} disabled={busy}>Cancelar</Button>
              <Button type="submit" form="pppoe-reveal-form" loading={busy}>Mostrar senha</Button>
            </>
          )}
      >
        {revealed ? (
          <dl className="technical-item-meta">
            <div><dt>Utilizador PPPoE</dt><dd><code>{revealed.username ?? '-'}</code></dd></div>
            <div><dt>Senha PPPoE</dt><dd><code>{revealed.password}</code></dd></div>
          </dl>
        ) : (
          <form id="pppoe-reveal-form" className="client-form" onSubmit={submit}>
            <Field
              wide
              label="A sua password"
              type="password"
              autoComplete="current-password"
              hint="Só administradores podem ver a senha. A consulta fica registada na auditoria."
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={error ?? undefined}
            />
          </form>
        )}
      </Dialog>
    </>
  );
}
