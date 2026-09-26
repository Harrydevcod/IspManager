import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Message } from '../../components';
import { authFetch } from '../../lib/auth';

type VaultState = 'ready' | 'recovery_pending' | 'locked' | 'absent';

export function VaultPanel() {
  const [status, setStatus] = useState<VaultState | null>(null);
  const [migrationError, setMigrationError] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [unlockKey, setUnlockKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void authFetch('http://127.0.0.1:3001/api/vault/status')
      .then(async (response) => {
        if (!response.ok) throw new Error('Estado indisponível.');
        return response.json() as Promise<{ status: VaultState; migrationError?: string }>;
      })
      .then((result) => { if (!cancelled) { setStatus(result.status); setMigrationError(result.migrationError ?? ''); } })
      .catch(() => { if (!cancelled) setError('Não foi possível consultar o cofre.'); });
    return () => { cancelled = true; };
  }, []);

  async function send(endpoint: string, body: object) {
    setBusy(true);
    setError('');
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/vault/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const result = await response.json() as { error?: string; recoveryKey?: string; status?: VaultState; migrationError?: string };
      if (!response.ok) throw new Error(result.error ?? 'Operação indisponível.');
      if (result.recoveryKey) setRecoveryKey(result.recoveryKey);
      if (result.migrationError) setMigrationError(result.migrationError);
      if (result.status) { setStatus(result.status); setRecoveryKey(''); setConfirmation(''); setUnlockKey(''); }
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Operação indisponível.');
    } finally { setBusy(false); }
  }

  function deliver(event: FormEvent) { event.preventDefault(); void send('recovery-key', { password }); }
  function confirm(event: FormEvent) {
    event.preventDefault();
    if (confirmation !== recoveryKey) { setError('A chave reintroduzida não coincide.'); return; }
    void send('confirm', { recoveryKey: confirmation });
  }
  function unlock(event: FormEvent) { event.preventDefault(); void send('unlock', { recoveryKey: unlockKey }); }

  return <section className="vault-panel" aria-label="Cofre de credenciais">
    <h3>Cofre de credenciais</h3>
    {status === null && !error && <p>A consultar o estado do cofre…</p>}
    {status === 'ready' && <Message tone="success">O cofre está desbloqueado.</Message>}
    {status === 'absent' && <Message tone="neutral">O cofre só pode ser criado na aplicação Electron.</Message>}
    {migrationError && <Message tone="error">Há credenciais por converter: {migrationError}. As integrações e os backups normais estão suspensos.</Message>}
    <p>Os backups antigos continuam a precisar da chave de recuperação da sua geração.</p>
    {error && <Message tone="error">{error}</Message>}
    {status === 'recovery_pending' && <>
      <Message tone="neutral">Guarde a chave de recuperação num local seguro.</Message>
      {!recoveryKey ? <form onSubmit={deliver}>
        <Field label="Palavra-passe atual" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <Button type="submit" disabled={busy}>Mostrar chave de recuperação</Button>
      </form> : <>
        <p className="vault-recovery-key">{recoveryKey}</p>
        <form onSubmit={confirm}>
          <Field label="Reintroduza a chave de recuperação" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" required />
          <Button type="submit" disabled={busy}>Confirmar chave guardada</Button>
        </form>
      </>}
    </>}
    {status === 'locked' && <>
      <Message tone="error">O cofre está trancado. As credenciais e os backups normais estão indisponíveis até ao desbloqueio.</Message>
      <form onSubmit={unlock}>
        <Field label="Chave de recuperação" type="password" value={unlockKey} onChange={(event) => setUnlockKey(event.target.value)} autoComplete="off" required />
        <Button type="submit" disabled={busy}>Desbloquear cofre</Button>
      </form>
    </>}
  </section>;
}
