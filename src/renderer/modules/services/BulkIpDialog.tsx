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
};

type BulkIpDialogProps = {
  onClose: () => void;
  onSaved: () => void;
};

/**
 * Atribuição de IPs em massa. Cada equipamento ativo já vem com o prefixo da rede
 * preenchido para só faltar o último octeto — quem quiser outra faixa reescreve a
 * linha inteira. Linhas deixadas apenas com o prefixo contam como vazias.
 */
export function BulkIpDialog({ onClose, onSaved }: BulkIpDialogProps) {
  const { toast } = useToast();
  const [rows, setRows] = useState<ActiveAssignment[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/service-device-assignments')
      .then((response) => response.ok ? response.json() as Promise<ActiveAssignment[]> : Promise.reject(new Error('load')))
      .then((data) => {
        const prefix = suggestIpPrefix(data.map((row) => row.ipAddress));
        setRows(data);
        setDrafts(Object.fromEntries(data.map((row) => [row.id, row.ipAddress || prefix])));
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const prefix = useMemo(() => suggestIpPrefix(rows.map((row) => row.ipAddress)), [rows]);
  const filled = rows.filter((row) => isFilled(drafts[row.id], prefix)).length;

  function isFilled(value: string | undefined, currentPrefix: string) {
    const trimmed = (value || '').trim();
    return trimmed !== '' && trimmed !== currentPrefix;
  }

  // Filtrar é só uma vista: os rascunhos vivem por id, por isso escrever num
  // campo, filtrar e voltar atrás não perde nada, e gravar continua a olhar
  // para a lista toda.
  const term = search.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    if (onlyEmpty && isFilled(drafts[row.id], prefix)) {
      return false;
    }
    if (!term) {
      return true;
    }
    return [row.clientName, row.brand, row.model, row.serialNumber, drafts[row.id]]
      .some((value) => (value || '').toLowerCase().includes(term));
  });

  async function save() {
    // Só viaja o que mudou; o prefixo sozinho conta como campo por preencher.
    const items = rows.flatMap((row) => {
      const ipAddress = isFilled(drafts[row.id], prefix) ? drafts[row.id].trim() : '';
      return ipAddress === (row.ipAddress || '') ? [] : [{ id: row.id, ipAddress }];
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
        toast(data.error || 'Não foi possível gravar os IPs.', 'error');
        return;
      }
      toast(`${data.updated} IP(s) gravado(s).`, 'success');
      onSaved();
      onClose();
    } catch {
      toast('Falha de rede ao gravar os IPs.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      size="xl"
      eyebrow="Manutenção remota"
      title="Atribuir IPs aos equipamentos"
      onClose={submitting ? () => undefined : onClose}
      closeOnBackdrop={!submitting}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button onClick={() => void save()} loading={submitting} disabled={loading || rows.length === 0}>
            {submitting ? 'A gravar...' : 'Gravar IPs'}
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
          description="Assim que instalares equipamento nos serviços, aparece aqui para atribuir IP."
        />
      )}
      {!loading && rows.length > 0 && (
        <div className="bulk-ip">
          <div className="bulk-ip-toolbar">
            <p className="bulk-ip-intro">
              <strong>{filled}</strong> de {rows.length} com IP. Escreve só o número final; para outra faixa, reescreve a
              linha inteira.
            </p>
            <div className="bulk-ip-filters">
              <Field
                type="search"
                label="Procurar"
                hideLabel
                placeholder="Cliente, equipamento ou IP"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button
                variant={onlyEmpty ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setOnlyEmpty((current) => !current)}
                aria-pressed={onlyEmpty}
              >
                Por preencher ({rows.length - filled})
              </Button>
            </div>
          </div>
          <div className="bulk-ip-table">
            <div className="bulk-ip-head">
              <span>Cliente e equipamento</span>
              <span>IP</span>
            </div>
            {visibleRows.length === 0 && (
              <p className="bulk-ip-none">Nenhum equipamento corresponde ao filtro.</p>
            )}
            {visibleRows.map((row) => (
              <div key={row.id} className="bulk-ip-row">
                <span className="bulk-ip-device">
                  <strong>{row.clientName}</strong>
                  <small>
                    {row.brand ? `${row.brand} ${row.model}` : row.model}
                    {row.serialNumber ? ` · ${row.serialNumber}` : ''}
                  </small>
                </span>
                <IpField
                  hideLabel
                  ariaLabel={`IP de ${row.clientName}, ${row.model}`}
                  value={drafts[row.id] ?? ''}
                  prefix={prefix}
                  onChange={(ipAddress) => setDrafts((current) => ({ ...current, [row.id]: ipAddress }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
