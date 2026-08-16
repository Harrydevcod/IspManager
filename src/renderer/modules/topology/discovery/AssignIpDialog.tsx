import { useEffect, useState } from 'react';
import { Button, Dialog, Field, Message } from '../../../components';
import { createBackboneApi } from '../backbone-api';
import type { BackboneAssignmentSummary } from '../../../../shared/backbone';

type Props = {
  ip: string;
  mac: string | null;
  onClose: () => void;
  onAssign: (assignmentId: number) => Promise<void>;
};

const api = createBackboneApi();

/**
 * Escolhe o serviço a que este endereço pertence.
 *
 * A lista é a mesma `/api/topology/assignments` que o backbone já usa para
 * ligar equipamentos — pesquisa por nome ou código de cliente, e mostra o IP
 * que a atribuição tem hoje para se ver o que vai ser substituído.
 */
export function AssignIpDialog({ ip, mac, onClose, onAssign }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<BackboneAssignmentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api.listAssignments({ query: query.trim() || undefined, mapping: 'all', page: 1, pageSize: 15 })
        .then((page) => {
          if (controller.signal.aborted) return;
          setRows(page.items);
          setError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : 'Falha ao procurar serviços');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  async function assign(assignmentId: number) {
    setPending(assignmentId);
    setError(null);
    try {
      await onAssign(assignmentId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Falha ao atribuir o endereço');
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open title={`Atribuir ${ip} a um serviço`} onClose={onClose}>
      <div className="discovery-assign">
        <p className="discovery-assign-lead">
          O endereço passa a constar no equipamento instalado do serviço escolhido.
          {mac ? <> O MAC <code>{mac}</code> é gravado com ele.</> : null}
        </p>

        <Field
          label="Procurar cliente"
          placeholder="Nome ou código do cliente"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />

        {error ? <Message tone="error">{error}</Message> : null}

        {loading && rows.length === 0 ? (
          <p className="discovery-assign-empty">A procurar…</p>
        ) : rows.length === 0 ? (
          <p className="discovery-assign-empty">Nenhum serviço com equipamento instalado corresponde à procura.</p>
        ) : (
          <ul className="discovery-assign-list">
            {rows.map((row) => (
              <li key={row.id}>
                <div className="discovery-assign-who">
                  <strong>{row.clientName}</strong>
                  <span>{row.clientCode} · {row.catalogBrand ? `${row.catalogBrand} ` : ''}{row.catalogModel}</span>
                  <small>{row.ipAddress ? `IP atual ${row.ipAddress}` : 'sem IP registado'}</small>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pending === row.id}
                  disabled={pending !== null || row.ipAddress === ip}
                  onClick={() => void assign(row.id)}
                >
                  {row.ipAddress === ip ? 'Já é este' : 'Atribuir'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
