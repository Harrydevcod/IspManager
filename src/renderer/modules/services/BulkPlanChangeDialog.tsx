import { ArrowRightLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, DataTable, Dialog, EmptyState, Field, Message, Select, SkeletonList, Toggle, useToast, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';
import type { PlanRow } from '../../types';
import {
  batchTime, batchVerdict, ITEM_STATUS, nextOccurrence, OUTCOME, PLAN_CHANGE_API,
  type DropMode, type PlanChangeBatch, type PlanChangeItem, type PlanChangePreview, type PreviewRow
} from './plan-change-api';
import './BulkPlanChangeDialog.css';

const POLL_MS = 1000;
const clock = new Intl.DateTimeFormat('pt-PT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const PREVIEW_COLUMNS: DataTableColumn<PreviewRow>[] = [
  { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => <strong>{row.clientName}</strong> },
  { header: 'Plano atual', sortValue: (row) => row.fromPlanName ?? '', cell: (row) => row.fromPlanName ?? '—' },
  { header: 'Paga hoje', align: 'end', sortValue: (row) => row.fromValueCve + row.rentalCve, defaultDirection: 'desc', cell: (row) => formatCve(row.fromValueCve + row.rentalCve) },
  {
    header: 'Passa a pagar',
    align: 'end',
    sortValue: (row) => row.toValueCve + row.rentalCve,
    defaultDirection: 'desc',
    cell: (row) => row.toValueCve === row.fromValueCve
      ? <span className="muted">{formatCve(row.toValueCve + row.rentalCve)}</span>
      : <b>{formatCve(row.toValueCve + row.rentalCve)}</b>
  },
  { header: 'Sessão', sortValue: (row) => (row.online ? 0 : 1), cell: (row) => row.online ? <Badge tone="success">Ligado</Badge> : <span className="muted">—</span> },
  { header: 'O que acontece', sortValue: (row) => OUTCOME[row.outcome].rank, cell: (row) => <Badge tone={OUTCOME[row.outcome].tone}>{OUTCOME[row.outcome].label}</Badge> }
];

const RESULT_COLUMNS: DataTableColumn<PlanChangeItem>[] = [
  { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => <strong>{row.clientName}</strong> },
  { header: 'Plano anterior', sortValue: (row) => row.fromPlanName ?? '', cell: (row) => row.fromPlanName ?? '—' },
  { header: 'Resultado', sortValue: (row) => ITEM_STATUS[row.status].rank, cell: (row) => <Badge tone={ITEM_STATUS[row.status].tone}>{ITEM_STATUS[row.status].label}</Badge> },
  { header: 'Sessão', sortValue: (row) => (row.sessionDroppedAt ? 0 : 1), cell: (row) => row.sessionDroppedAt ? 'Derrubada' : <span className="muted">—</span> },
  { header: 'Detalhe', sortValue: (row) => row.error ?? row.note ?? '', cell: (row) => row.error ?? row.note ?? '' }
];

/** Os resultados de um lote, com as falhas primeiro. Usado no fim da operação e no histórico. */
export function PlanChangeResult({ batch }: { batch: PlanChangeBatch }) {
  const { counts } = batch;
  const verdict = batchVerdict(batch);
  const dropAt = batchTime(batch.dropAt);
  return (
    <>
      <div className="plan-change-summary">
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        <span className={counts.applied ? undefined : 'is-zero'}><b>{counts.applied}</b> aplicados</span>
        <span className={counts.unchanged ? undefined : 'is-zero'}><b>{counts.unchanged}</b> sem alteração</span>
        <span className={counts.failed ? 'is-bad' : 'is-zero'}><b>{counts.failed}</b> falhados</span>
        <span className={counts.not_processed ? 'is-bad' : 'is-zero'}><b>{counts.not_processed}</b> por processar</span>
      </div>
      {batch.stopReason && <Message tone={batch.status === 'stopped' ? 'error' : 'neutral'}>{batch.stopReason}</Message>}
      {batch.status === 'cancelled' && counts.applied > 0 && (
        <Message>Os {counts.applied} já processados ficaram no plano novo. Os restantes não foram tocados.</Message>
      )}
      {batch.dryRun === 1 && <Message>O router está em ensaio: o plano mudou no ISPM e o router não foi alterado.</Message>}
      {batch.dropStatus === 'pending' && dropAt && <Message>As sessões abertas antes da mudança são derrubadas {clock.format(dropAt)}.</Message>}
      {batch.dropStatus === 'expired' && <Message tone="error">A hora marcada passou com o ISPM desligado: nenhuma sessão foi derrubada.</Message>}
      <DataTable
        rows={batch.items ?? []}
        rowKey={(row) => row.id}
        defaultSort={{ key: 'Resultado', direction: 'asc' }}
        gridTemplateColumns="minmax(140px, 1.2fr) minmax(128px, 0.9fr) minmax(120px, 0.8fr) minmax(90px, 0.6fr) minmax(180px, 2fr)"
        columns={RESULT_COLUMNS}
        empty={<EmptyState icon={ArrowRightLeft} title="Sem serviços" description="Este lote não tem itens." />}
      />
    </>
  );
}

type Step = 'options' | 'preview' | 'run';
const STEPS: readonly Step[] = ['options', 'preview', 'run'];

export function BulkPlanChangeDialog({ serviceIds, plans, onClose, onDone }: {
  serviceIds: number[];
  plans: PlanRow[];
  onClose: () => void;
  /** Houve escrita: a lista de serviços tem de ser lida outra vez. */
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('options');
  const [targetPlanId, setTargetPlanId] = useState('');
  const [updatePrice, setUpdatePrice] = useState(true);
  const [dropMode, setDropMode] = useState<DropMode>('none');
  const [dropTime, setDropTime] = useState('04:00');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [batch, setBatch] = useState<PlanChangeBatch | null>(null);

  const running = batchId !== null && (!batch || batch.status === 'running');
  const input = { serviceIds, targetPlanId: Number(targetPlanId), updatePrice };

  // O progresso lê-se da base: o lote corre no servidor e continua mesmo que o diálogo feche.
  const batchStatus = batch?.status;
  useEffect(() => {
    if (batchId === null || (batchStatus && batchStatus !== 'running')) return;
    let alive = true;
    const read = () => {
      authFetch(`${PLAN_CHANGE_API}/${batchId}`)
        .then((response) => (response.ok ? response.json() as Promise<PlanChangeBatch> : null))
        .then((body) => { if (alive && body) setBatch(body); })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [batchId, batchStatus]);

  async function post<T>(url: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    try {
      const response = await authFetch(url, {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      });
      const result = await response.json() as T & { error?: string };
      if (!response.ok) {
        toast(result.error ?? 'O pedido falhou.', 'error');
        return null;
      }
      return result;
    } catch {
      toast('Falha de rede.', 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    const result = await post<PlanChangePreview>(`${PLAN_CHANGE_API}/preview`, input);
    if (result) { setPreview(result); setStep('preview'); }
  }

  async function execute() {
    const result = await post<{ batchId: number }>(PLAN_CHANGE_API, {
      ...input,
      reason: reason.trim() || null,
      dropMode,
      dropAt: dropMode === 'scheduled' ? nextOccurrence(dropTime) : null
    });
    if (result) { setBatchId(result.batchId); setStep('run'); }
  }

  function close() {
    if (batchId !== null) onDone();
    onClose();
  }

  const dropAt = dropMode === 'scheduled' ? nextOccurrence(dropTime) : null;
  const processed = batch ? batch.counts.applied + batch.counts.unchanged + batch.counts.failed + batch.counts.not_processed : 0;
  const total = batch?.items?.length ?? serviceIds.length;

  const actions = step === 'options' ? (
    <>
      <Button variant="secondary" onClick={close}>Cancelar</Button>
      <Button loading={busy} disabled={!targetPlanId || (dropMode === 'scheduled' && !dropAt)} onClick={() => void loadPreview()}>Pré-visualizar</Button>
    </>
  ) : step === 'preview' ? (
    <>
      <Button variant="secondary" onClick={() => setStep('options')}>Voltar</Button>
      <Button loading={busy} disabled={!preview || preview.blockers.length > 0} onClick={() => void execute()}>
        Mudar {preview?.toChange ?? 0} {preview?.toChange === 1 ? 'cliente' : 'clientes'} de plano
      </Button>
    </>
  ) : running ? (
    <Button variant="secondary" loading={busy} onClick={() => void post(`${PLAN_CHANGE_API}/${batchId}/cancel`)}>Cancelar o que falta</Button>
  ) : (
    <Button onClick={close}>Fechar</Button>
  );

  return (
    <Dialog
      open
      onClose={close}
      // A meio da execução um clique fora não pode fechar o que mostra o progresso.
      closeOnBackdrop={step !== 'run'}
      eyebrow={`Serviços · passo ${STEPS.indexOf(step) + 1} de ${STEPS.length}`}
      title={step === 'run' ? (running ? 'A mudar de plano…' : 'Mudança de plano') : `Mudar ${serviceIds.length} ${serviceIds.length === 1 ? 'serviço' : 'serviços'} de plano`}
      size={step === 'options' ? 'md' : 'xl'}
      actions={actions}
    >
      {step === 'options' && (
        <div className="client-form plan-change-options">
          <Select label="Plano de destino" value={targetPlanId} onChange={(event) => setTargetPlanId(event.target.value)}>
            <option value="">Escolher…</option>
            {plans.filter((plan) => plan.active).map((plan) => (
              <option key={plan.id} value={plan.id}>{plan.name} · {formatCve(plan.monthlyPriceCve)}</option>
            ))}
          </Select>
          <Toggle
            title="A mensalidade acompanha o preço do plano"
            description="Desligado, muda só o plano e a velocidade; o valor de cada serviço fica como está."
            wide={false}
            checked={updatePrice}
            onChange={(event) => setUpdatePrice(event.target.checked)}
          />
          <Select
            label="Quando aplicar a velocidade nova"
            hint={dropMode === 'now'
              ? 'Quem estiver ligado fica sem rede uns segundos: o equipamento volta a ligar sozinho, já com a velocidade nova.'
              : 'O router só aplica a velocidade nova quando a sessão PPPoE volta a ligar.'}
            value={dropMode}
            onChange={(event) => setDropMode(event.target.value as DropMode)}
          >
            <option value="none">Quando o cliente voltar a ligar: ninguém é derrubado</option>
            <option value="now">Já: derruba a sessão e o cliente volta a ligar em segundos</option>
            <option value="scheduled">A uma hora marcada</option>
          </Select>
          {dropMode === 'scheduled' && (
            <Field
              type="time"
              label="Hora"
              value={dropTime}
              onChange={(event) => setDropTime(event.target.value)}
              hint={dropAt ? `Próxima: ${clock.format(new Date(dropAt))}. O ISPM tem de estar aberto a essa hora.` : 'Indique a hora.'}
            />
          )}
          <Field
            label="Motivo"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Fica no histórico: campanha, correção, pedido do cliente…"
          />
        </div>
      )}

      {step === 'preview' && preview && (
        <>
          {preview.blockers.map((blocker) => <Message key={blocker} tone="error">{blocker}</Message>)}
          <div className="plan-change-summary">
            <span><b>{preview.toChange}</b> {preview.toChange === 1 ? 'muda' : 'mudam'} para <b>{preview.targetPlan?.name ?? '—'}</b></span>
            {preview.groups.map((group) => <span key={group.planName}>{group.count} de {group.planName}</span>)}
          </div>
          {preview.sessionsOnline > 0 && dropMode === 'now' && (
            <Message tone="warn">
              {preview.sessionsOnline} {preview.sessionsOnline === 1 ? 'cliente está ligado e a sessão vai ser derrubada' : 'clientes estão ligados e as sessões vão ser derrubadas'} agora. Voltam a ligar-se sozinhos em segundos.
            </Message>
          )}
          {preview.sessionsOnline > 0 && dropMode === 'scheduled' && dropAt && (
            <Message tone="warn">
              As sessões de {preview.sessionsOnline} {preview.sessionsOnline === 1 ? 'cliente ligado vão' : 'clientes ligados vão'} ser derrubadas {clock.format(new Date(dropAt))}.
            </Message>
          )}
          {preview.sessionsOnline > 0 && dropMode === 'none' && (
            <Message>
              {preview.sessionsOnline} {preview.sessionsOnline === 1 ? 'está ligado' : 'estão ligados'}: ninguém é derrubado, e só {preview.sessionsOnline === 1 ? 'apanha' : 'apanham'} a velocidade nova quando {preview.sessionsOnline === 1 ? 'voltar a ligar' : 'voltarem a ligar'}.
            </Message>
          )}
          {preview.dryRun && <Message>O router está em ensaio: o plano muda no ISPM e o router não é alterado.</Message>}
          <DataTable
            rows={preview.rows}
            rowKey={(row) => row.serviceId}
            defaultSort={{ key: 'O que acontece', direction: 'asc' }}
            gridTemplateColumns="minmax(120px, 1.1fr) minmax(110px, 0.9fr) 100px 116px 76px minmax(200px, 1.2fr)"
            columns={PREVIEW_COLUMNS}
            empty={<EmptyState icon={ArrowRightLeft} title="Sem serviços" description="Nenhum dos serviços escolhidos existe." />}
          />
        </>
      )}

      {step === 'run' && (
        <>
          {running && (
            <div className="plan-change-progress">
              <div className="plan-change-bar" role="progressbar" aria-label="Progresso da mudança de plano" aria-valuemin={0} aria-valuemax={total} aria-valuenow={processed}>
                <span style={{ transform: `scaleX(${total ? processed / total : 0})` }} />
              </div>
              <span>{processed} de {total}</span>
            </div>
          )}
          {batch ? <PlanChangeResult batch={batch} /> : <SkeletonList rows={Math.min(serviceIds.length, 5)} />}
        </>
      )}
    </Dialog>
  );
}
