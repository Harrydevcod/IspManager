import { useEffect, useState } from 'react';
import { authFetch } from '../lib/auth';

type BackupItem = { file: string; createdAt: string; sizeBytes: number };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupsPanel() {
  const [entries, setEntries] = useState<BackupItem[]>([]);
  const [backupDir, setBackupDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmFile, setConfirmFile] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  async function load() {
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/backups');
      const data = await res.json();
      setEntries(data.entries);
      setBackupDir(data.backupDir);
    } catch {
      setMessage('Nao foi possivel carregar a lista de backups.');
    }
  }

  useEffect(() => { void load(); }, []);

  async function createNow() {
    setBusy(true);
    setMessage('');
    try {
      await authFetch('http://127.0.0.1:3001/api/backups', { method: 'POST' });
      await load();
      setMessage('Backup criado.');
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(file: string) {
    setBusy(true);
    setMessage('');
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
      if (!res.ok) {
        const e = await res.json();
        setMessage(`Erro: ${e.error}`);
        return;
      }
      if (window.ispm?.relaunch) {
        await window.ispm.relaunch();
      } else {
        setMessage('Restauro concluido. Feche e reabra a aplicacao para carregar os dados restaurados.');
      }
    } finally {
      setBusy(false);
      setConfirmFile(null);
      setConfirmText('');
    }
  }

  return (
    <section className="backups-panel">
      <header className="backups-head">
        <div>
          <h3>Backups</h3>
          <p className="backups-dir">{backupDir}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void createNow()}>
          Criar backup agora
        </button>
      </header>

      {message && <p className="backups-msg">{message}</p>}

      <ul className="backups-list">
        {entries.map((e) => (
          <li key={e.file}>
            <span>{new Date(e.createdAt).toLocaleString('pt-PT')}</span>
            <span>{formatBytes(e.sizeBytes)}</span>
            {confirmFile === e.file ? (
              <span className="backups-confirm">
                <input
                  placeholder="escreva RESTAURAR"
                  value={confirmText}
                  onChange={(ev) => setConfirmText(ev.target.value)}
                />
                <button
                  type="button"
                  className="backups-danger"
                  disabled={busy || confirmText !== 'RESTAURAR'}
                  onClick={() => void doRestore(e.file)}
                >
                  Confirmar
                </button>
                <button type="button" onClick={() => { setConfirmFile(null); setConfirmText(''); }}>
                  Cancelar
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmFile(e.file)}>Restaurar</button>
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="backups-empty">Sem backups ainda.</li>}
      </ul>
    </section>
  );
}
