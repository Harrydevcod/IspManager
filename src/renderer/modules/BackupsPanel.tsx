import { Archive, FolderOpen, FolderSearch, HardDriveDownload, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, Field, Message, Select, SkeletonList, useConfirm } from '../components';
import { authFetch } from '../lib/auth';
import { formatPtDateTime } from '../lib/format';

type BackupItem = { file: string; createdAt: string; sizeBytes: number };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const rtf = new Intl.RelativeTimeFormat('pt', { numeric: 'auto' });

/** "há 2 horas" / "ontem" — para leitura rápida na lista e no estado. */
function relativePt(iso: string, now = Date.now()): string {
  const mins = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, 'day');
  return rtf.format(Math.round(days / 30), 'month');
}

/** Origem derivada do prefixo do ficheiro; backups normais não levam badge. */
function backupKind(file: string): { label: string; tone: 'info' | 'neutral' } | null {
  if (file.startsWith('imported-')) return { label: 'Importado', tone: 'info' };
  if (file.startsWith('pre-restore-')) return { label: 'Pré-restauro', tone: 'neutral' };
  return null;
}

const INTERVAL_PRESETS = [
  { value: 0, label: 'Desligado' },
  { value: 6, label: 'A cada 6 horas' },
  { value: 12, label: 'A cada 12 horas' },
  { value: 24, label: 'Diário' },
  { value: 48, label: 'A cada 2 dias' },
  { value: 168, label: 'Semanal' }
];

export function BackupsPanel() {
  const [entries, setEntries] = useState<BackupItem[]>([]);
  const [loading, setLoading] = useState(true);
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
    } finally {
      setLoading(false);
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

  async function pickDir() {
    if (!window.ispm?.chooseBackupDir) return;
    const picked = await window.ispm.chooseBackupDir();
    if (picked) setDirInput(picked);
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

  const latest = entries[0] ?? null;
  const intervalHours = Number(intervalInput) || 0;
  const hasCustomInterval = intervalHours > 0 && !INTERVAL_PRESETS.some((p) => p.value === intervalHours);

  return (
    <section className="backups-panel">
      <header className="backups-head">
        <div>
          <h3>Backups</h3>
          <p className="backups-dir">
            Cópias completas da base de dados. Restaurar substitui os dados atuais e reinicia a aplicação.
          </p>
        </div>
        <div className="backups-head-actions">
          <Button variant="secondary" disabled={busy} leadingIcon={<Upload size={14} aria-hidden />} onClick={() => void importBackup()}>
            Importar backup…
          </Button>
          <Button variant="primary" loading={busy} leadingIcon={<HardDriveDownload size={14} aria-hidden />} onClick={() => void createNow()}>
            Criar backup agora
          </Button>
        </div>
      </header>

      {message && <Message tone={message.tone}>{message.text}</Message>}

      <div className="backups-stats">
        <div className="backups-stat">
          <span>Último backup</span>
          <strong>{loading ? '—' : latest ? relativePt(latest.createdAt) : 'Nunca'}</strong>
          <small>{latest ? formatPtDateTime(latest.createdAt) : 'Cria o primeiro para proteger os dados'}</small>
        </div>
        <div className="backups-stat">
          <span>Automático</span>
          <strong>{intervalHours > 0 ? `A cada ${intervalHours} h` : 'Desligado'}</strong>
          <small>{intervalHours > 0 ? 'Corre em segundo plano com a app aberta' : 'Ativa abaixo na configuração'}</small>
        </div>
        <div className="backups-stat">
          <span>Retenção</span>
          <strong>14 dias + 8 semanas</strong>
          <small>Um por dia; mais antigos, um por semana</small>
        </div>
      </div>

      <Card eyebrow="Configuração" className="backups-card">
        <div className="backups-config">
          <div className="backups-config-dir">
            <Field
              label="Pasta de destino"
              placeholder="Predefinição da aplicação"
              value={dirInput}
              spellCheck={false}
              onChange={(ev) => setDirInput(ev.target.value)}
            />
            {window.ispm?.chooseBackupDir && (
              <Button variant="secondary" leadingIcon={<FolderSearch size={14} aria-hidden />} onClick={() => void pickDir()}>
                Escolher…
              </Button>
            )}
          </div>
          <Select
            label="Backup automático"
            value={intervalInput}
            onChange={(ev) => setIntervalInput(ev.target.value)}
          >
            {INTERVAL_PRESETS.map((p) => (
              <option key={p.value} value={String(p.value)}>{p.label}</option>
            ))}
            {hasCustomInterval && <option value={String(intervalHours)}>A cada {intervalHours} h</option>}
          </Select>
          <Button variant="secondary" loading={savingConfig} onClick={() => void saveConfig()}>
            Guardar
          </Button>
        </div>
        <p className="backups-config-hint">
          Deixa a pasta vazia para usar a predefinição. Uma pasta sincronizada (Drive, Dropbox, OneDrive) funciona como backup externo.
        </p>
        <p className="backups-effective">
          <span>A guardar em</span>
          <code title={backupDir}>{backupDir || '—'}</code>
          {window.ispm?.openBackupDir && backupDir && (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<FolderOpen size={13} aria-hidden />}
              onClick={() => void window.ispm?.openBackupDir?.(backupDir)}
            >
              Abrir pasta
            </Button>
          )}
        </p>
      </Card>

      <Card
        eyebrow="Histórico"
        className="backups-card"
        actions={!loading && entries.length > 0 ? <span className="backups-count">{entries.length} ficheiros</span> : undefined}
      >
        {loading ? (
          <SkeletonList rows={4} />
        ) : entries.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Archive}
            title="Sem backups ainda"
            description="Cria o primeiro backup agora ou importa um ficheiro .sqlite existente."
          />
        ) : (
          <ul className="backups-list">
            {entries.map((e, i) => {
              const kind = backupKind(e.file);
              return (
                <li key={e.file}>
                  <div className="backups-item-meta">
                    <strong>{formatPtDateTime(e.createdAt)}</strong>
                    <small>{relativePt(e.createdAt)} · {formatBytes(e.sizeBytes)}</small>
                  </div>
                  {i === 0 && <Badge tone="success">Mais recente</Badge>}
                  {kind && <Badge tone={kind.tone}>{kind.label}</Badge>}
                  {confirmFile === e.file ? (
                    <span className="backups-confirm">
                      <Field
                        label="Confirmar restauro"
                        placeholder="escreva RESTAURAR"
                        aria-label="Confirmar restauro escrevendo RESTAURAR"
                        autoFocus
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
                    <Button variant="ghost" size="sm" onClick={() => { setConfirmFile(e.file); setConfirmText(''); }}>
                      Restaurar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
