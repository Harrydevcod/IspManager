import { Eye, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Message, Select, useToast } from '../../components';
import { authFetch } from '../../lib/auth';
import { downloadAuthenticated, printAuthenticated } from '../../lib/download';

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

/**
 * Fichas do técnico para migrar os clientes de DHCP para PPPoE: utilizador, senha e
 * onde os escrever. O PDF leva as senhas em claro, por isso é o mesmo travão da
 * revelação (admin e a password outra vez) e imprimir não deixa ficheiro.
 */
export function PppoeMigrationCardsDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [scope, setScope] = useState<'pending' | 'all'>('pending');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'print' | 'save' | null>(null);

  async function run(kind: 'print' | 'save') {
    if (!password) {
      setError('Confirme a sua password para gerar as fichas.');
      return;
    }
    setBusy(kind);
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, scope }) };
    // A password nunca fica em memória depois de enviada.
    setPassword('');
    try {
      const url = `${API}/pppoe-migration-cards.pdf`;
      if (kind === 'print') {
        const result = await printAuthenticated(url, init);
        if (result.canceled) return;
      } else {
        const result = await downloadAuthenticated(url, 'fichas-migracao-pppoe.pdf', init);
        if (result.canceled) return;
      }
      toast(kind === 'print' ? 'Fichas enviadas para a impressora.' : 'Fichas guardadas. Apague o ficheiro depois da migração.', 'success');
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível gerar as fichas.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      eyebrow="PPPoE"
      title="Fichas de migração PPPoE"
      size="sm"
      closeOnBackdrop={!busy}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={!!busy}>Cancelar</Button>
          <Button variant="secondary" onClick={() => void run('save')} loading={busy === 'save'} disabled={!!busy}>Guardar PDF</Button>
          <Button onClick={() => void run('print')} loading={busy === 'print'} disabled={!!busy}>Imprimir</Button>
        </>
      }
    >
      <form className="client-form" onSubmit={(event) => { event.preventDefault(); void run('print'); }}>
        <Message tone="warn">
          As fichas levam as senhas em claro. Prefira imprimir; um PDF guardado apaga-se depois da migração.
        </Message>
        <Select wide label="Serviços" value={scope} onChange={(event) => setScope(event.target.value as 'pending' | 'all')}
          hint={scope === 'pending' ? 'Os que nunca ligaram por PPPoE.' : 'Todos os activos com PPPoE.'}>
          <option value="pending">Por migrar</option>
          <option value="all">Todos</option>
        </Select>
        <Field
          wide
          label="A sua password"
          type="password"
          autoComplete="current-password"
          hint="Só administradores. A geração fica registada na auditoria."
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={error ?? undefined}
        />
      </form>
    </Dialog>
  );
}
