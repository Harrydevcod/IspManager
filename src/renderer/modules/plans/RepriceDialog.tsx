import { useEffect, useState } from 'react';
import { Button, Dialog, ErrorRetry, Message } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';

const API_BASE = 'http://127.0.0.1:3001';

export type RepriceRow = {
  serviceId: number;
  clientName: string;
  currentCve: number;
  rentalCve: number;
  lastInvoiceCve: number | null;
  newTotalCve: number;
  deltaCve: number;
  changed: boolean;
};

type Props = {
  planId: number;
  planName: string;
  onClose: () => void;
  onApplied: (updated: number) => void;
};

/**
 * Aplicar o preço do plano aos serviços já instalados.
 *
 * Existe porque o valor mensal de cada serviço é um instantâneo copiado na
 * criação: mudar o preço do plano não toca em quem já lá está. E porque isto
 * mexe na fatura de dezenas de clientes de uma vez — ninguém deve carregar num
 * botão desses sem ver primeiro, cliente a cliente, o que vai mudar.
 */
export function RepriceDialog({ planId, planName, onClose, onApplied }: Props) {
  const [rows, setRows] = useState<RepriceRow[] | null>(null);
  const [priceCve, setPriceCve] = useState(0);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    authFetch(`${API_BASE}/api/plans/${planId}/reprice-preview`)
      .then(async (response) => {
        const data = await response.json() as {
          error?: string;
          plan?: { monthlyPriceCve: number };
          rows?: RepriceRow[];
        };
        if (!response.ok) throw new Error(data.error || 'Nao foi possivel calcular o impacto');
        setRows(data.rows ?? []);
        setPriceCve(data.plan?.monthlyPriceCve ?? 0);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Falha ao calcular o impacto'))
      .finally(() => setLoading(false));
  }

  useEffect(load, [planId]);

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      const response = await authFetch(`${API_BASE}/api/plans/${planId}/reprice`, { method: 'POST' });
      const data = await response.json() as { error?: string; updated?: number };
      if (!response.ok) throw new Error(data.error || 'Nao foi possivel aplicar o preco');
      onApplied(data.updated ?? 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Falha ao aplicar o preco');
    } finally {
      setApplying(false);
    }
  }

  const changed = (rows ?? []).filter((row) => row.changed);
  const sobe = changed.filter((row) => row.deltaCve > 0).length;
  const desce = changed.filter((row) => row.deltaCve < 0).length;
  const igual = changed.filter((row) => row.deltaCve === 0).length;

  return (
    <Dialog
      open
      size="xl"
      eyebrow="Preços"
      title={`Aplicar ${formatCve(priceCve)} aos serviços de ${planName}`}
      onClose={onClose}
      closeOnBackdrop={!applying}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={applying}>Cancelar</Button>
          <Button onClick={() => void apply()} loading={applying} disabled={changed.length === 0}>
            {changed.length === 0 ? 'Nada a aplicar' : `Aplicar a ${changed.length} serviço(s)`}
          </Button>
        </>
      )}
    >
      <div className="reprice">
        <p className="reprice-lead">
          O valor mensal de cada serviço é copiado do plano quando o serviço é criado, por isso
          mudar o preço do plano não altera quem já está instalado. O total novo já inclui o
          aluguer do equipamento — é o valor que vai sair na próxima fatura.
        </p>

        {loading && <Message>A calcular o impacto…</Message>}
        {error && <ErrorRetry message={error} onRetry={load} />}

        {rows && !loading && (
          rows.length === 0 ? (
            <Message>Este plano não tem serviços ativos.</Message>
          ) : (
            <>
              <div className="reprice-summary">
                <span><strong>{sobe}</strong> sobem</span>
                <span><strong>{desce}</strong> descem</span>
                <span><strong>{igual}</strong> ficam iguais</span>
                <span className="reprice-summary-muted">
                  {rows.length - changed.length} já alinhado(s)
                </span>
              </div>

              <div className="reprice-table-scroll">
                <table className="reprice-table">
                  <thead>
                    <tr>
                      <th scope="col">Cliente</th>
                      {/* Só a parte de internet: o audiovisual não entra aqui
                          nem no total novo, continua a ser cobrado por cima. */}
                      <th scope="col">Última mensalidade</th>
                      <th scope="col">Aluguer</th>
                      <th scope="col">Nova fatura</th>
                      <th scope="col">Diferença</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.serviceId} className={row.changed ? undefined : 'is-aligned'}>
                        <td>{row.clientName}</td>
                        <td>{row.lastInvoiceCve === null ? '—' : formatCve(row.lastInvoiceCve)}</td>
                        <td>{row.rentalCve > 0 ? formatCve(row.rentalCve) : '—'}</td>
                        <td>{formatCve(row.newTotalCve)}</td>
                        <td className={row.deltaCve > 0 ? 'is-up' : row.deltaCve < 0 ? 'is-down' : undefined}>
                          {row.deltaCve === 0 ? '—' : `${row.deltaCve > 0 ? '+' : ''}${formatCve(row.deltaCve)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}
      </div>
    </Dialog>
  );
}
