import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, EmptyState, Field, Message, SkeletonList, useToast } from '../../components';
import { authFetch } from '../../lib/auth';
import { suggestIpPrefix } from '../../lib/ip';
import { IpField } from './IpField';
import { Cable } from 'lucide-react';

export type ActiveAssignment = {
  id: number;
  serviceId: number;
  clientId: number;
  clientName: string;
  brand: string | null;
  model: string;
  catalogType: string;
  serialNumber: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  /** Clientes servidos por partilha (a antena é a mesma unidade física). */
  sharedWithNames: string | null;
};

type BulkIdentityDialogProps = {
  onClose: () => void;
  onSaved: () => void;
};

/** O que se pode escrever numa linha. Os rascunhos vivem por id, não por posição. */
type Draft = { ipAddress: string; macAddress: string };

/**
 * Identificação em massa do parque instalado. Duas colunas por equipamento: o IP
 * da manutenção remota — com o prefixo da rede já preenchido, para só faltar o
 * último octeto — e o MAC, que é o que identifica a unidade quando a etiqueta da
 * série já não se lê. Linhas deixadas apenas com o prefixo contam como vazias.
 */
export function BulkIpDialog({ onClose, onSaved }: BulkIdentityDialogProps) {
  const { toast } = useToast();
  const [rows, setRows] = useState<ActiveAssignment[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyUnidentified, setOnlyUnidentified] = useState(false);

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/service-device-assignments')
      .then((response) => response.ok ? response.json() as Promise<ActiveAssignment[]> : Promise.reject(new Error('load')))
      .then((data) => {
        const prefix = suggestIpPrefix(data.map((row) => row.ipAddress));
        setRows(data);
        setDrafts(Object.fromEntries(data.map((row) => [row.id, {
          ipAddress: row.ipAddress || prefix,
          macAddress: row.macAddress || ''
        }])));
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const prefix = useMemo(() => suggestIpPrefix(rows.map((row) => row.ipAddress)), [rows]);

  function isFilled(value: string | undefined, currentPrefix = '') {
    const trimmed = (value || '').trim();
    return trimmed !== '' && trimmed !== currentPrefix;
  }

  /**
   * Identificado = tem MAC ou série. É a mesma regra do aviso na topologia: o IP
   * ficou de fora de propósito, porque um router em DHCP não tem nenhum e nem por
   * isso está por identificar.
   */
  function isIdentified(row: ActiveAssignment) {
    return isFilled(drafts[row.id]?.macAddress) || isFilled(row.serialNumber || '');
  }

  const withIp = rows.filter((row) => isFilled(drafts[row.id]?.ipAddress, prefix)).length;
  const identified = rows.filter(isIdentified).length;

  // Filtrar é só uma vista: os rascunhos vivem por id, por isso escrever num
  // campo, filtrar e voltar atrás não perde nada, e gravar continua a olhar
  // para a lista toda.
  const term = search.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    if (onlyUnidentified && isIdentified(row)) {
      return false;
    }
    if (!term) {
      return true;
    }
    return [
      row.clientName, row.sharedWithNames, row.brand, row.model, row.serialNumber,
      drafts[row.id]?.ipAddress, drafts[row.id]?.macAddress
    ].some((value) => (value || '').toLowerCase().includes(term));
  });

  function update(id: number, patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  async function save() {
    // Só viaja o que mudou; o prefixo sozinho conta como campo por preencher.
    const items = rows.flatMap((row) => {
      const draft = drafts[row.id];
      const ipAddress = isFilled(draft?.ipAddress, prefix) ? draft.ipAddress.trim() : '';
      const macAddress = isFilled(draft?.macAddress) ? draft.macAddress.trim() : '';
      const untouched = ipAddress === (row.ipAddress || '') && macAddress === (row.macAddress || '');
      return untouched ? [] : [{ id: row.id, ipAddress, macAddress }];
    });

    if (items.length === 0) {
      toast('Nada para gravar.', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/service-device-assignments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });
      const data = await response.json() as { error?: string; updated?: number };
      if (!response.ok) {
        toast(data.error || 'Não foi possível gravar.', 'error');
        return;
      }
      toast(`${data.updated} equipamento(s) atualizado(s).`, 'success');
      onSaved();
      onClose();
    } catch {
      toast('Falha de rede ao gravar.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      size="xl"
      eyebrow="Inventário e manutenção remota"
      title="Identificar os equipamentos"
      onClose={submitting ? () => undefined : onClose}
      closeOnBackdrop={!submitting}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button onClick={() => void save()} loading={submitting} disabled={loading || rows.length === 0}>
            {submitting ? 'A gravar...' : 'Gravar'}
          </Button>
        </>
      }
    >
      {loading && <SkeletonList rows={6} />}
      {loadError && <Message tone="error">Não foi possível carregar os equipamentos.</Message>}
      {!loading && !loadError && rows.length === 0 && (
        <EmptyState
          size="sm"
          icon={Cable}
          title="Sem equipamento instalado"
          description="Assim que instalares equipamento nos serviços, aparece aqui para identificar."
        />
      )}
      {!loading && rows.length > 0 && (
        <div className="bulk-ip">
          <div className="bulk-ip-toolbar">
            <p className="bulk-ip-intro">
              <strong>{identified}</strong> de {rows.length} identificados · <strong>{withIp}</strong> com IP. No IP
              escreve só o número final; para outra faixa, reescreve a linha inteira.
            </p>
            <div className="bulk-ip-filters">
              <Field
                type="search"
                label="Procurar"
                hideLabel
                placeholder="Cliente, equipamento, IP ou MAC"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button
                variant={onlyUnidentified ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setOnlyUnidentified((current) => !current)}
                aria-pressed={onlyUnidentified}
              >
                Por identificar ({rows.length - identified})
              </Button>
            </div>
          </div>
          <div className="bulk-ip-table">
            <div className="bulk-ip-head">
              <span>Cliente e equipamento</span>
              <span>IP</span>
              <span>MAC</span>
            </div>
            {visibleRows.length === 0 && (
              <p className="bulk-ip-none">Nenhum equipamento corresponde ao filtro.</p>
            )}
            {visibleRows.map((row) => (
              <div key={row.id} className="bulk-ip-row">
                <span className="bulk-ip-device">
                  <strong>
                    {row.clientName}
                    {row.sharedWithNames && <span className="bulk-ip-shared"> + {row.sharedWithNames}</span>}
                  </strong>
                  <small>
                    {row.brand ? `${row.brand} ${row.model}` : row.model}
                    {row.serialNumber ? ` · ${row.serialNumber}` : ''}
                  </small>
                </span>
                <IpField
                  hideLabel
                  ariaLabel={`IP de ${row.clientName}, ${row.model}`}
                  value={drafts[row.id]?.ipAddress ?? ''}
                  prefix={prefix}
                  onChange={(ipAddress) => update(row.id, { ipAddress })}
                />
                <Field
                  hideLabel
                  label="MAC"
                  aria-label={`MAC de ${row.clientName}, ${row.model}`}
                  placeholder="AA:BB:CC:DD:EE:FF"
                  value={drafts[row.id]?.macAddress ?? ''}
                  onChange={(event) => update(row.id, { macAddress: event.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
