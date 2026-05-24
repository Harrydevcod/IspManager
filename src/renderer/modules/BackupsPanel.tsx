import { useEffect, useState } from 'react';
import { Button, Field, Message } from '../components';
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

  async function importBackup() {
    if (!window.ispm?.chooseBackupFile) {
      setMessage('Importação só disponível no Electron desktop.');
      return;
    }
    const picked = await window.ispm.chooseBackupFile();
    if (!picked) return;
    if (!window.confirm(
      'Importar este backup vai SUBSTITUIR a base de dados actual. ' +
      'Uma cópia da base actual será guardada em pre-restore-*.sqlite. Continuar?'
    )) {
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/backups/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: picked })
      });
      if (!res.ok) {
        const e = await res.json();
        setMessage(`Erro: ${e.error}`);
        return;
      }
      if (window.ispm?.relaunch) {
        await window.ispm.relaunch();
      } else {
        setMessage('Importação concluída. Reabra a aplicação para carregar a base restaurada.');
      }
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
        <div className="backups-head-actions">
          <Button variant="secondary" disabled={busy} onClick={() => void importBackup()}>
            Importar backup…
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void createNow()}>
            Criar backup agora
          </Button>
        </div>
      </header>

      {message && <Message>{message}</Message>}

      <ul className="backups-list">
        {entries.map((e) => (
          <li key={e.file}>
            <span>{new Date(e.createdAt).toLocaleString('pt-PT')}</span>
            <span>{formatBytes(e.sizeBytes)}</span>
            {confirmFile === e.file ? (
              <span className="backups-confirm">
                <Field
                  label="Confirmar restauro"
                  placeholder="escreva RESTAURAR"
                  aria-label="Confirmar restauro escrevendo RESTAURAR"
                  value={confirmText}
                  onChange={(ev) => setConfirmText(ev.target.value)}
                />
                <Button
                  variant="danger"
                  size="sm"
                  disabled={confirmText !== 'RESTAURAR'}
                  loading={busy}
                  onClick={() => void doRestore(e.file)}
                >
                  Confirmar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setConfirmFile(null); setConfirmText(''); }}
                >
                  Cancelar
                </Button>
              </span>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmFile(e.file)}>
                Restaurar
              </Button>
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="backups-empty">Sem backups ainda.</li>}
      </ul>
    </section>
  );
}
