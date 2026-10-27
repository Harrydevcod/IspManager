import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { Badge, Button, DataTable, Dialog, EmptyState, ErrorRetry, Message, SkeletonList, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { ImportDropzone } from '../clients/import/ImportDropzone';
import { parseFile } from '../clients/import/parseFile';
import { buildEquipmentPreview, equipmentTemplate, EQUIPMENT_LABELS, type EquipmentAssignment, type EquipmentPreview } from './equipment-import';
import '../clients/import/ClientImportDialog.css';
import './EquipmentImportDialog.css';

const API = 'http://127.0.0.1:3001/api/service-device-assignments';

export function EquipmentImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [equipment, setEquipment] = useState<EquipmentAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<EquipmentPreview[] | null>(null);
  const [filename, setFilename] = useState('');
  const [saving, setSaving] = useState(false);
  const [updated, setUpdated] = useState<number | null>(null);
  const busy = parsing || saving;

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setLoadError(null);
    authFetch(API).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível carregar os equipamentos.');
      if (!disposed) setEquipment(body);
    }).catch((failure: unknown) => {
      if (!disposed) setLoadError(failure instanceof Error ? failure.message : 'Falha de rede ao carregar os equipamentos.');
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [attempt]);

  function download() {
    const url = URL.createObjectURL(new Blob([equipmentTemplate(equipment)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'equipamentos-ispm.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function pick(file: File) {
    if (busy) return;
    setError(null);
    setPreview(null);
    setUpdated(null);
    setParsing(true);
    try {
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error('Use um ficheiro CSV ou Excel .xlsx. Para .xls, guarde primeiro como .xlsx.');
      if (file.size > 5 * 1024 * 1024) throw new Error('O ficheiro excede 5 MB. Divida-o em ficheiros mais pequenos.');
      const parsed = await parseFile(file);
      if (parsed.rows.length === 0) throw new Error('O ficheiro não contém equipamentos.');
      if (parsed.rows.length > 1000) throw new Error('Importe até 1000 linhas de cada vez.');
      setPreview(buildEquipmentPreview(parsed.rows, parsed.headers, equipment));
      setFilename(file.name);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível ler o ficheiro.');
    } finally { setParsing(false); }
  }

  const patches = preview?.flatMap((row) => row.patch ? [row.patch] : []) ?? [];
  const rejected = preview?.filter((row) => row.errors.length > 0) ?? [];
  const unchanged = preview?.filter((row) => !row.errors.length && !row.patch).length ?? 0;

  async function apply() {
    if (busy || updated !== null || patches.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch(API, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: patches })
      });
      const body = await response.json() as { error?: string; updated: number };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível aplicar as alterações.');
      setUpdated(body.updated);
      // O modelo descarregado a seguir tem de reflectir o que acabou de ser gravado.
      const byId = new Map(patches.map((patch) => [patch.id, patch]));
      setEquipment((current) => current.map((row) => ({ ...row, ...byId.get(row.id) })));
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Falha de rede ao gravar.');
    } finally { setSaving(false); }
  }

  const columns: DataTableColumn<EquipmentPreview>[] = [
    { header: 'Linha', cell: (row) => <span>{row.line}</span> },
    { header: 'Equipamento', cell: (row) => <div className="equipment-import-device"><strong>{row.equipment?.clientName ?? 'Não identificado'}</strong><span>{row.equipment?.clientCode ?? '—'} · ID {row.id ?? 'inválido'}</span><span>{row.equipment?.model ?? 'Atribuição desconhecida'}</span></div> },
    { header: 'Alterações', cell: (row) => row.changes.length ? <dl className="equipment-import-changes">{row.changes.map((change) => <div key={change.field}><dt>{EQUIPMENT_LABELS[change.field]}</dt><dd><span>{change.before ?? 'Vazio'}</span><span aria-label="passa a"> → </span><strong>{change.after ?? 'Vazio'}</strong></dd></div>)}</dl> : 'Sem alterações' },
    { header: 'Validação', cell: (row) => row.errors.length ? <div className="equipment-import-errors"><Badge tone="danger">Recusada</Badge>{row.errors.map((message) => <span key={message}>{message}</span>)}</div> : <Badge tone={row.patch ? 'success' : 'neutral'}>{row.patch ? 'Pronta' : 'Sem alterações'}</Badge> }
  ];

  return <Dialog open size="xl" eyebrow="Inventário instalado" title="Importar equipamentos" onClose={busy ? () => undefined : onClose} closeOnBackdrop={!busy}
    actions={<><Button variant="secondary" onClick={onClose} disabled={busy}>{updated === null ? 'Cancelar' : 'Fechar'}</Button>{updated === null && <Button leadingIcon={<Upload size={15} aria-hidden />} loading={saving} disabled={loading || parsing || patches.length === 0} onClick={() => void apply()}>Aplicar {patches.length} alteração(ões)</Button>}</>}>
    <div className="equipment-import">
      {loading ? <SkeletonList rows={4} /> : loadError ? <ErrorRetry message={loadError} onRetry={() => setAttempt((value) => value + 1)} /> : equipment.length === 0 ? <EmptyState icon={Upload} title="Sem equipamento instalado" description="Instale equipamentos nos serviços antes de descarregar o modelo." /> : <>
        {!preview && <ImportDropzone parsing={parsing} parseError={error} downloadingTemplate={false} onPick={(file) => void pick(file)} onDownloadTemplate={download}
          templateLabel="Descarregar modelo CSV" templateHint={`${equipment.length} atribuição(ões) ativa(s), com os valores atuais.`} accept=".csv,.xlsx" acceptLabel=".csv .xlsx"
          help={<p>Descarregue o modelo e preencha MAC, IP, modo WAN, modo de operação ou gama LAN. Mantenha o ID e o código do cliente. Uma célula vazia limpa o valor; retirar a coluna preserva-o. A pré-visualização mostra tudo antes de gravar. Aceita CSV e Excel .xlsx, até 1000 linhas e 5 MB.</p>} />}
        {preview && <>
          <div className="equipment-import-summary"><div><strong>{filename}</strong><p>{patches.length} a atualizar · {unchanged} sem alterações · {rejected.length} recusada(s)</p></div><Button variant="ghost" disabled={busy} onClick={() => { setPreview(null); setError(null); setUpdated(null); }}>Escolher outro ficheiro</Button></div>
          {updated === null ? <Message tone="neutral">Só serão aplicadas as linhas válidas com alterações. As recusadas ficam de fora.</Message> : <Message tone="success">{updated} equipamento(s) atualizado(s). {rejected.length} linha(s) recusada(s), sem alterações.</Message>}
          {error && <Message tone="error">{error}</Message>}
          <DataTable className="equipment-import-table" rows={updated === null ? preview : rejected} rowKey={(row) => row.line} columns={columns} gridTemplateColumns="3rem minmax(9rem, 1fr) minmax(12rem, 1.7fr) minmax(9rem, 1fr)" empty={null} />
        </>}
      </>}
    </div>
  </Dialog>;
}
