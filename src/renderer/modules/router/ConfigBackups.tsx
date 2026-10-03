import { useEffect, useState } from 'react';
import { Button, DataTable, Dialog, EmptyState, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatPtDateTime } from '../../lib/format';
import { lineDiff } from '../../../shared/line-diff';
import { ROUTER_API } from './router-api';

export type ConfigSnapshot = {
  id: number;
  takenAt: string;
  routerosVersion: string | null;
  lines: number;
  addedLines: number;
  removedLines: number;
};

export type ConfigSnapshots = { checkedAt: string | null; snapshots: ConfigSnapshot[] };

type SnapshotDetail = { id: number; takenAt: string; content: string; previousContent: string | null };

const columns: DataTableColumn<ConfigSnapshot>[] = [
  { header: 'Data', sortValue: (row) => row.takenAt, defaultDirection: 'desc', cell: (row) => formatPtDateTime(row.takenAt) },
  { header: 'RouterOS', sortValue: (row) => row.routerosVersion ?? '', cell: (row) => row.routerosVersion ?? '—' },
  { header: 'Linhas', sortValue: (row) => row.lines, defaultDirection: 'desc', align: 'end', cell: (row) => row.lines },
  { header: 'Acrescentadas', sortValue: (row) => row.addedLines, defaultDirection: 'desc', align: 'end', cell: (row) => row.addedLines },
  { header: 'Removidas', sortValue: (row) => row.removedLines, defaultDirection: 'desc', align: 'end', cell: (row) => row.removedLines }
];

function download(detail: SnapshotDetail) {
  const url = URL.createObjectURL(new Blob([detail.content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `router-${detail.takenAt.slice(0, 10)}.rsc`;
  link.click();
  URL.revokeObjectURL(url);
}

function SnapshotDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [error, setError] = useState(false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    let alive = true;
    authFetch(`${ROUTER_API}/config/snapshots/${id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as SnapshotDetail;
        if (alive) setDetail(body);
      })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [id]);

  // A primeira cópia não tem com que comparar: mostra-se o texto.
  const showFull = full || detail?.previousContent == null;
  const changes = detail && !showFull ? lineDiff(detail.previousContent!, detail.content).filter((line) => line.kind !== 'same') : [];

  return (
    <Dialog open onClose={onClose} size="xl" eyebrow="Configuração do router"
      title={detail ? formatPtDateTime(detail.takenAt) : 'A ler a cópia…'}
      actions={detail && (
        <>
          {detail.previousContent != null && (
            <Button variant="ghost" onClick={() => setFull((current) => !current)}>{full ? 'Ver só as diferenças' : 'Ver o texto completo'}</Button>
          )}
          <Button variant="secondary" onClick={() => download(detail)}>Descarregar .rsc</Button>
        </>
      )}>
      {error && <p role="alert" className="router-muted">Não foi possível ler a cópia.</p>}
      {detail && (showFull
        ? <pre className="router-config-text">{detail.content}</pre>
        : (
          <pre className="router-config-text" aria-label="Diferenças face à cópia anterior">
            {changes.map((line, index) => (
              <span key={index} className={line.kind === 'added' ? 'is-added' : 'is-removed'}>
                {line.kind === 'added' ? '+ ' : '− '}{line.text}{'\n'}
              </span>
            ))}
          </pre>
        ))}
    </Dialog>
  );
}

export function ConfigBackups({ data, onChanged }: { data: ConfigSnapshots; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const copyNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await authFetch(`${ROUTER_API}/config/snapshots`, { method: 'POST' });
      const body = await response.json() as { stored?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível copiar a configuração.');
      setNotice(body.stored ? 'Cópia guardada.' : 'Sem alterações desde a última cópia.');
      onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível copiar a configuração.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="router-usage-actions">
        <Button variant="secondary" onClick={copyNow} disabled={busy}>{busy ? 'A copiar…' : 'Copiar agora'}</Button>
        <span className="router-muted">
          Sem passwords · só se guarda quando a configuração muda
          {data.checkedAt && ` · verificada em ${formatPtDateTime(data.checkedAt)}`}
        </span>
      </div>
      {notice && <p role="status" className="router-muted">{notice}</p>}
      <DataTable rows={data.snapshots} rowKey={(row) => row.id} columns={columns}
        onRowClick={(row) => setSelectedId(row.id)} activeKey={selectedId}
        gridTemplateColumns="minmax(140px, 1.2fr) minmax(90px, 1fr) repeat(3, minmax(96px, .8fr))"
        defaultSort={{ key: 'Data', direction: 'desc' }}
        empty={<EmptyState title="Ainda sem cópias" description="A primeira é feita sozinha com o ISPM aberto na rede de gestão, ou já com Copiar agora." />} />
      {selectedId !== null && <SnapshotDialog id={selectedId} onClose={() => setSelectedId(null)} />}
    </>
  );
}
