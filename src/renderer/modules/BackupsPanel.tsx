import { Archive } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, EmptyState, Field, Message, useConfirm } from '../components';
import { authFetch } from '../lib/auth';
import { formatPtDateTime } from '../lib/format';

type BackupItem = { file: string; createdAt: string; sizeBytes: number };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupsPanel() {
  const [entries, setEntries] = useState<BackupItem[]>([]);
  const [backupDir, setBackupDir] = useState('');
  const [dirInput, setDirInput] = useState('');
  const [intervalInput, setIntervalInput] = useState('0');
  const [savingConfig, setSavingConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone?: 'error' | 'success' } | null>(null);
  const [confirmFile, setConfirmFile] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const confirm = useConfirm();

  async function load() {
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/backups');
      const data = await res.json();
      setEntries(data.entries);
      setBackupDir(data.backupDir);
      setDirInput(data.configuredBackupDir ?? '');
      setIntervalInput(String(data.intervalHours ?? 0));
    } catch {
      setMessage({ text: 'Não foi possível carregar a lista de backups.', tone: 'error' });
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveConfig() {
    setSavingConfig(true);
    setMessage(null);
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/backups/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupDir: dirInput.trim(), intervalHours: Number(intervalInput) || 0 })
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setMessage({ text: e.error || 'Não foi possível guardar a configuração.', tone: 'error' });
        return;
      }
      await load();
      setMessage({ text: 'Configuração de backups guardada.', tone: 'success' });
    } catch {
      setMessage({ text: 'Falha de rede ao guardar a configuração.', tone: 'error' });
    } finally {
      setSavingConfig(false);
    }
  }

  async function createNow() {
    setBusy(true);
    setMessage(null);
    try {
      await authFetch('http://127.0.0.1:3001/api/backups', { method: 'POST' });
      await load();
      setMessage({ text: 'Backup criado.', tone: 'success' });
    } finally {
      setBusy(false);
    }
  }

  async function importBackup() {
    if (!window.ispm?.chooseBackupFile) {
      setMessage({ text: 'Importação só disponível no Electron desktop.' });
      return;
    }
    const picked = await window.ispm.chooseBackupFile();
    if (!picked) return;
    if (!(await confirm({
      title: 'Importar backup',
      message: 'Importar este backup vai SUBSTITUIR a base de dados actual. Uma cópia da base actual será guardada em pre-restore-*.sqlite. Continuar?',
      tone: 'danger',
      confirmLabel: 'Importar e substituir'
    }))) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/backups/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: picked })
      });
      if (!res.ok) {
        const e = await res.json();
        setMessage({ text: `Erro: ${e.error}`, tone: 'error' });
        return;
      }
      if (window.ispm?.relaunch) {
        await window.ispm.relaunch();
      } else {
        setMessage({ text: 'Importação concluída. Reabra a aplicação para carregar a base restaurada.', tone: 'success' });
      }
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(file: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
      if (!res.ok) {
        const e = await res.json();
        setMessage({ text: `Erro: ${e.error}`, tone: 'error' });
        return;
      }
      if (window.ispm?.relaunch) {
        await window.ispm.relaunch();
      } else {
        setMessage({ text: 'Restauro concluído. Feche e reabra a aplicação para carregar os dados restaurados.', tone: 'success' });
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

      {message && <Message tone={message.tone}>{message.text}</Message>}

      <div className="backups-config">
        <Field
          label="Pasta de destino (vazio = predefinição)"
          placeholder="ex: D:\\Dropbox\\ISPM-backups (pasta sincronizada para backup externo)"
          value={dirInput}
          spellCheck={false}
          onChange={(ev) => setDirInput(ev.target.value)}
        />
        <Field
          label="Backup automático a cada (horas, 0 = desligado)"
          type="number"
          min={0}
          max={168}
          value={intervalInput}
          onChange={(ev) => setIntervalInput(ev.target.value)}
        />
        <Button variant="secondary" loading={savingConfig} onClick={() => void saveConfig()}>
          Guardar configuração
        </Button>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Archive}
          title="Sem backups ainda"
          description="Cria o primeiro backup agora ou importa um ficheiro .sqlite existente."
        />
      ) : (
      <ul className="backups-list">
        {entries.map((e) => (
          <li key={e.file}>
            <span>{formatPtDateTime(e.createdAt)}</span>
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
      </ul>
      )}
    </section>
  );
}
