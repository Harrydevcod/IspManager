import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, DataTable, Dialog, EmptyState, ErrorRetry, SkeletonList, useToast, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { PlanChangeResult } from '../services/BulkPlanChangeDialog';
import { batchTime, batchVerdict, PLAN_CHANGE_API, type PlanChangeBatch } from '../services/plan-change-api';

const when = new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
const total = (batch: PlanChangeBatch) => Object.values(batch.counts).reduce((sum, count) => sum + count, 0);

const COLUMNS: DataTableColumn<PlanChangeBatch>[] = [
  { header: 'Quando', sortValue: (row) => row.createdAt, defaultDirection: 'desc', cell: (row) => when.format(batchTime(row.createdAt)!) },
  { header: 'Plano de destino', sortValue: (row) => row.targetPlanName, cell: (row) => <strong>{row.targetPlanName}</strong> },
  { header: 'Serviços', align: 'end', sortValue: total, defaultDirection: 'desc', cell: (row) => total(row) },
  { header: 'Falhados', align: 'end', sortValue: (row) => row.counts.failed + row.counts.not_processed, defaultDirection: 'desc', cell: (row) => row.counts.failed + row.counts.not_processed || '—' },
  { header: 'Por', sortValue: (row) => row.createdByName ?? '', cell: (row) => row.createdByName ?? '—' },
  { header: 'Motivo', sortValue: (row) => row.reason ?? '', cell: (row) => row.reason ?? '' },
  { header: 'Resultado', sortValue: (row) => batchVerdict(row).label, cell: (row) => <Badge tone={batchVerdict(row).tone}>{batchVerdict(row).label}</Badge> }
];

/** O histórico das mudanças de plano em massa: quem mudou quem, quando e porquê. */
export function PlanChangeHistory({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [batches, setBatches] = useState<PlanChangeBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PlanChangeBatch | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const url = openId === null ? PLAN_CHANGE_API : `${PLAN_CHANGE_API}/${openId}`;
    authFetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        if (!alive) return;
        if (openId === null) setBatches(body as PlanChangeBatch[]);
        else setDetail(body as PlanChangeBatch);
        setError(null);
      })
      .catch(() => { if (alive) setError('Não foi possível ler o histórico.'); });
    return () => { alive = false; };
  }, [openId, tick]);

  async function cancelDrop(batch: PlanChangeBatch) {
    const response = await authFetch(`${PLAN_CHANGE_API}/${batch.id}/cancel`, { method: 'POST' });
    if (!response.ok) toast('Não foi possível desmarcar as sessões.', 'error');
    else toast('As sessões agendadas já não vão ser derrubadas.', 'success');
    setTick((current) => current + 1);
  }

  const back = () => { setOpenId(null); setDetail(null); };

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Planos"
      title={detail ? `Mudança para ${detail.targetPlanName} · ${when.format(batchTime(detail.createdAt)!)}` : 'Mudanças de plano em massa'}
      size="xl"
      actions={openId === null ? <Button onClick={onClose}>Fechar</Button> : (
        <>
          {detail?.dropStatus === 'pending' && <Button variant="secondary" onClick={() => void cancelDrop(detail)}>Não derrubar as sessões</Button>}
          <Button variant="secondary" onClick={back}>Voltar à lista</Button>
        </>
      )}
    >
      {error ? <ErrorRetry message={error} onRetry={() => setTick((current) => current + 1)} />
        : openId !== null ? (detail ? (
          <>
            <p className="muted">{[detail.createdByName && `Por ${detail.createdByName}`, detail.reason].filter(Boolean).join(' · ') || 'Sem motivo registado.'}</p>
            <PlanChangeResult batch={detail} />
          </>
        ) : <SkeletonList rows={5} />)
        : !batches ? <SkeletonList rows={5} /> : (
          <DataTable
            rows={batches}
            rowKey={(row) => row.id}
            defaultSort={{ key: 'Quando', direction: 'desc' }}
            onRowClick={(row) => setOpenId(row.id)}
            gridTemplateColumns="minmax(120px, 0.9fr) minmax(130px, 1.1fr) 80px 80px minmax(80px, 0.6fr) minmax(160px, 1.6fr) minmax(140px, 1fr)"
            columns={COLUMNS}
            empty={<EmptyState icon={History} title="Ainda sem mudanças em massa" description="Selecione serviços no módulo Serviços e use “Mudar de plano”." />}
          />
        )}
    </Dialog>
  );
}
