import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AlertCircle, ArrowRight, DatabaseBackup, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth, setAuthFetchToken } from '../lib/auth';

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  useEffect(() => {
    setAuthFetchToken(auth.token);
  }, [auth.token]);

  if (auth.status.kind === 'loading') {
    return (
      <div className="auth-shell auth-loading">
        <Loader2 size={20} className="spin" aria-hidden />
        <span>a iniciar...</span>
      </div>
    );
  }
  if (auth.status.kind === 'setup-required') {
    return <SetupScreen />;
  }
  if (auth.status.kind === 'login-required') {
    return <LoginScreen lastError={auth.status.lastError} />;
  }
  return <>{children}</>;
}

function SetupScreen() {
  const auth = useAuth();
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (password.length < 8) {
      setError('A password deve ter pelo menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('As passwords nao coincidem.');
      return;
    }
    setSubmitting(true);
    try {
      await auth.setupAdmin(username.trim(), password, fullName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup falhou.');
    } finally {
      setSubmitting(false);
    }
  }

  // Primeiro arranque com um backup de outra máquina: restaura a BD antes de
  // existir qualquer conta (rota gated no backend por "sem utilizadores") e
  // relança a app — no arranque seguinte entra-se com as credenciais do backup.
  async function importBackup() {
    if (importing) return;
    setError(null);
    const filePath = await window.ispm?.chooseBackupFile?.();
    if (!filePath) return;
    setImporting(true);
    try {
      const response = await fetch('http://127.0.0.1:3001/api/backups/setup-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Importação falhou.');
      }
      if (window.ispm?.relaunch) {
        await window.ispm.relaunch();
      } else {
        await auth.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Importação falhou.');
      setImporting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <header className="auth-card-head">
          <span className="auth-brand">
            <span className="auth-brand-mark">I</span>
            <span className="auth-brand-word">ISPM</span>
          </span>
          <p className="auth-eyebrow">Primeira execucao</p>
          <h1>Cria a conta de administrador</h1>
          <p className="auth-lede">
            Esta conta vai gerir os utilizadores, definicoes e backups. Podes criar mais perfis depois.
          </p>
        </header>

        <form onSubmit={submit} className="auth-form">
          <label>
            <span>Nome completo</span>
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
              autoComplete="name"
              autoFocus
            />
          </label>
          <label>
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              minLength={2}
              autoComplete="username"
              spellCheck={false}
              placeholder="admin"
            />
          </label>
          <label>
            <span>Password (min. 8)</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Confirmar password</span>
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>

          {error && (
            <p className="auth-error" role="alert">
              <AlertCircle size={14} aria-hidden /> {error}
            </p>
          )}

          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'A criar...' : 'Criar admin'}
            {!submitting && <ArrowRight size={14} aria-hidden />}
          </button>
        </form>

        {window.ispm?.chooseBackupFile && (
          <div className="auth-setup-import">
            <p>Já usavas o ISPM noutra máquina? Restaura a base de dados a partir de um backup em vez de começar do zero.</p>
            <button
              type="button"
              className="auth-setup-import-btn"
              disabled={submitting || importing}
              onClick={() => void importBackup()}
            >
              <DatabaseBackup size={14} aria-hidden />
              {importing ? 'A restaurar...' : 'Importar backup da base de dados…'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function LoginScreen({ lastError }: { lastError?: string }) {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(lastError ?? null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await auth.login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login falhou.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <header className="auth-card-head">
          <span className="auth-brand">
            <span className="auth-brand-mark">I</span>
            <span className="auth-brand-word">ISPM</span>
          </span>
          <p className="auth-eyebrow">
            <ShieldCheck size={11} aria-hidden /> Sessao
          </p>
          <h1>Entrar na operacao</h1>
        </header>

        <form onSubmit={submit} className="auth-form">
          <label>
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoComplete="username"
              spellCheck={false}
              autoFocus
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
            />
          </label>

          {error && (
            <p className="auth-error" role="alert">
              <AlertCircle size={14} aria-hidden /> {error}
            </p>
          )}

          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'A entrar...' : 'Entrar'}
            {!submitting && <ArrowRight size={14} aria-hidden />}
          </button>
        </form>
      </div>
    </div>
  );
}
