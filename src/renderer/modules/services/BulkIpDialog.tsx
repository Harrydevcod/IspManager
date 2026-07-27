import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, EmptyState, Message, SkeletonList, useToast } from '../../components';
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
        toast(data.error || 'Nao foi possivel gravar os IPs.', 'error');
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
      eyebrow="Manutencao remota"
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
          description="Assim que instalares equipamento nos servicos, aparece aqui para atribuir IP."
        />
      )}
      {!loading && rows.length > 0 && (
        <>
          <Message>
            {filled} de {rows.length} com IP. O prefixo <strong>{prefix}</strong> vem sugerido da tua rede — escreve so o
            ultimo numero, ou reescreve a linha para usar outra faixa.
          </Message>
          <ul className="bulk-ip-list">
            {rows.map((row) => (
              <li key={row.id} className="bulk-ip-row">
                <span className="bulk-ip-device">
                  <strong>{row.clientName}</strong>
                  <small>
                    {row.brand ? `${row.brand} ${row.model}` : row.model} · {row.catalogType}
                    {row.serialNumber ? ` · ${row.serialNumber}` : ''}
                  </small>
                </span>
                <IpField
                  ariaLabel={`IP de ${row.clientName} — ${row.model}`}
                  value={drafts[row.id] ?? ''}
                  prefix={prefix}
                  onChange={(ipAddress) => setDrafts((current) => ({ ...current, [row.id]: ipAddress }))}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
