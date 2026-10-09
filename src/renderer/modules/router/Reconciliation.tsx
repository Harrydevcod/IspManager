import { ArrowLeftRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, BulkActionBar, Button, Combobox, DataTable, Dialog, EmptyState, Field, Select, useToast, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { useRowSelection } from '../../lib/useRowSelection';
import { ROUTER_API, type ReconDirection, type ReconKind, type ReconResult, type ReconRow, type Reconciliation as ReconciliationData } from './router-api';

const KIND: Record<ReconKind, { label: string; tone: 'danger' | 'warn' | 'info'; rank: number; ispm: string; router: string }> = {
  plan: { label: 'Plano diferente', tone: 'warn', rank: 0, ispm: 'Repor o plano do ISPM no router', router: 'Passar o serviço ao plano do router' },
  state: { label: 'Estado diferente', tone: 'danger', rank: 1, ispm: 'Impor o estado do ISPM no router', router: 'Trazer o estado do router' },
  only_ispm: { label: 'Só no ISPM', tone: 'info', rank: 2, ispm: 'Criar o utilizador no router', router: 'Tirar o utilizador do serviço' },
  only_router: { label: 'Só no router', tone: 'info', rank: 3, ispm: 'Desativar no router', router: 'Associar a um serviço' }
};

const RESULT: Record<ReconResult['status'], { label: string; tone: 'success' | 'danger' | 'info' | 'neutral' }> = {
  applied: { label: 'Aplicado', tone: 'success' },
  failed: { label: 'Falhou', tone: 'danger' },
  dry_run: { label: 'Ensaio', tone: 'info' },
  not_processed: { label: 'Por processar', tone: 'neutral' }
};

type Extra = { planId?: number; targetServiceId?: number; confirmName?: string };

/** Aplicar o ISPM a alguém que está ligado derruba-lhe a sessão quando o resultado é ficar sem serviço. */
function dropsSession(row: ReconRow, direction: ReconDirection): boolean {
  return row.online && direction === 'ispm' && (row.kind === 'only_router' || row.kind === 'state');
}

/** O que falta escolher antes de se poder aplicar esta decisão; null = nada. */
function missing(row: ReconRow, direction: ReconDirection, extra: Extra): string | null {
  if (direction === 'router' && row.kind === 'plan') {
    if (row.planOptions.length === 0) return `Nenhum plano do ISPM usa o perfil ${row.router}.`;
    if (row.planOptions.length > 1 && !extra.planId) return 'Escolha o plano.';
  }
  if (direction === 'router' && row.kind === 'only_router' && !extra.targetServiceId) return 'Escolha o serviço.';
  if (direction === 'ispm' && row.kind === 'only_router' && !row.managed && extra.confirmName !== row.login) return 'Escreva o nome do utilizador.';
  return null;
}

export function Reconciliation({ data, dryRun, onChanged }: { data: ReconciliationData; dryRun: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const selection = useRowSelection<string>();
  const [decisions, setDecisions] = useState<Record<string, ReconDirection>>({});
  const [extras, setExtras] = useState<Record<string, Extra>>({});
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReconResult[] | null>(null);

  const keys = useMemo(() => data.rows.map((row) => row.key), [data.rows]);
  // Só contam as decisões de linhas que ainda existem: a lista é lida ao vivo.
  const decided = data.rows.filter((row) => decisions[row.key]);
  const blocked = decided.some((row) => missing(row, decisions[row.key], extras[row.key] ?? {}));

  function decide(rowKeys: readonly string[], direction: ReconDirection | '') {
    setDecisions((current) => {
      const next = { ...current };
      for (const key of rowKeys) {
        if (direction) next[key] = direction;
        else delete next[key];
      }
      return next;
    });
  }

  const setExtra = (key: string, patch: Extra) => setExtras((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  function close() {
    setReviewing(false);
    if (results) {
      setResults(null);
      setDecisions({});
      setExtras({});
      selection.clear();
      onChanged();
    }
  }

  async function apply() {
    setBusy(true);
    try {
      const response = await authFetch(`${ROUTER_API}/reconciliation/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: decided.map((row) => ({ key: row.key, direction: decisions[row.key], ...extras[row.key] })) })
      });
      const body = await response.json() as { error?: string; results?: ReconResult[] };
      if (!response.ok || !body.results) toast(body.error ?? 'Não foi possível aplicar as decisões.', 'error');
      else setResults(body.results);
    } catch {
      toast('Falha de rede ao aplicar as decisões.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const columns: DataTableColumn<ReconRow>[] = [
    { header: 'Cliente', sortValue: (row) => row.clientName ?? '', cell: (row) => row.clientName ? <strong>{row.clientName}</strong> : <span className="router-muted">—</span> },
    { header: 'Utilizador PPPoE', sortValue: (row) => row.login, cell: (row) => <code className="router-mono">{row.login}</code> },
    { header: 'Diferença', sortValue: (row) => KIND[row.kind].rank, cell: (row) => <Badge tone={KIND[row.kind].tone}>{KIND[row.kind].label}</Badge> },
    { header: 'No ISPM', sortValue: (row) => row.ispm, cell: (row) => row.ispm },
    { header: 'No router', sortValue: (row) => row.router, cell: (row) => <>{row.router}{row.kind === 'only_router' && !row.managed ? ' · feito à mão' : ''}</> },
    {
      header: 'Situação',
      sortValue: (row) => (row.held ? 0 : 1),
      cell: (row) => row.held
        ? <Badge tone="warn">À espera de decisão</Badge>
        : <span title="Foi o ISPM que mudou: a passagem automática trata disto sozinha."><Badge tone="neutral">A aplicar sozinho</Badge></span>
    },
    {
      header: 'Decisão',
      // As já decididas primeiro: é o que se quer rever antes de aplicar.
      sortValue: (row) => (decisions[row.key] ? 0 : 1),
      cell: (row) => (
        <Select
          label={`Decisão para ${row.login}`}
          hideLabel
          value={decisions[row.key] ?? ''}
          onChange={(event) => decide([row.key], event.target.value as ReconDirection | '')}
        >
          <option value="">Não decidir agora</option>
          <option value="ispm">{KIND[row.kind].ispm}</option>
          <option value="router">{KIND[row.kind].router}</option>
        </Select>
      )
    }
  ];

  const resultByKey = new Map((results ?? []).map((result) => [result.key, result]));

  return (
    <>
      <div className="recon-bar">
        <p className="router-muted">
          Nada aqui é resolvido sozinho. Escolha, linha a linha, qual dos dois lados está certo.
          {dryRun ? ' O router está em ensaio: aplicar só diz o que faria.' : ''}
        </p>
        <Button disabled={decided.length === 0} onClick={() => setReviewing(true)}>
          Rever {decided.length || ''} {decided.length === 1 ? 'decisão' : 'decisões'}
        </Button>
      </div>

      <BulkActionBar count={selection.count} onClear={selection.clear} noun={{ one: 'selecionada', many: 'selecionadas' }}>
        <Button variant="secondary" size="sm" onClick={() => decide([...selection.selected], 'ispm')}>ISPM → router</Button>
        <Button variant="secondary" size="sm" onClick={() => decide([...selection.selected], 'router')}>Router → ISPM</Button>
        <Button variant="ghost" size="sm" onClick={() => decide([...selection.selected], '')}>Limpar decisão</Button>
      </BulkActionBar>

      <DataTable
        rows={data.rows}
        rowKey={(row) => row.key}
        className="recon-table"
        stickyHeader
        defaultSort={{ key: 'Situação', direction: 'asc' }}
        gridTemplateColumns="minmax(140px, 1.2fr) minmax(110px, 0.9fr) minmax(120px, 0.8fr) minmax(130px, 1.1fr) minmax(130px, 1.1fr) minmax(130px, 0.9fr) minmax(190px, 1.3fr)"
        columns={columns}
        selection={{
          isSelected: (key) => selection.isSelected(String(key)),
          onToggleRow: (key) => selection.toggle(String(key)),
          headerState: selection.visibleState(keys),
          onToggleAll: () => selection.toggleVisible(keys)
        }}
        empty={<EmptyState icon={ArrowLeftRight} title="ISPM e router de acordo" description="Não há utilizadores, planos nem estados diferentes entre os dois." />}
      />

      <Dialog
        open={reviewing}
        onClose={close}
        eyebrow="Reconciliação"
        title={results ? 'Resultado' : 'Confirmar decisões'}
        size="lg"
        actions={results
          ? <Button onClick={close}>Fechar</Button>
          : <>
              <Button variant="secondary" onClick={close}>Cancelar</Button>
              <Button loading={busy} disabled={blocked} onClick={() => void apply()}>
                {dryRun ? 'Ensaiar' : 'Aplicar'} {decided.length} {decided.length === 1 ? 'decisão' : 'decisões'}
              </Button>
            </>}
      >
        <ol className="client-form recon-review">
          {decided.map((row) => {
            const direction = decisions[row.key];
            const extra = extras[row.key] ?? {};
            const result = resultByKey.get(row.key);
            const gap = missing(row, direction, extra);
            return (
              <li key={row.key}>
                <div className="recon-review-head">
                  <strong>{row.clientName ?? row.login}</strong>
                  {result ? <Badge tone={RESULT[result.status].tone}>{RESULT[result.status].label}</Badge> : <Badge tone={KIND[row.kind].tone}>{KIND[row.kind].label}</Badge>}
                </div>
                <p>{result ? result.message : `${KIND[row.kind][direction]} — ISPM: ${row.ispm} · router: ${row.router}`}</p>
                {!result && dropsSession(row, direction) && <p className="recon-warning">Está ligado agora: a sessão vai ser derrubada.</p>}
                {!result && direction === 'router' && row.kind === 'plan' && row.planOptions.length > 1 && (
                  <Select label="Plano a atribuir" value={extra.planId ?? ''} onChange={(event) => setExtra(row.key, { planId: Number(event.target.value) || undefined })}>
                    <option value="">Escolher…</option>
                    {row.planOptions.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                  </Select>
                )}
                {!result && direction === 'router' && row.kind === 'only_router' && (
                  <Combobox
                    ariaLabel={`Serviço a que pertence ${row.login}`}
                    placeholder="Escolher o serviço…"
                    options={data.unlinkedServices}
                    value={extra.targetServiceId ?? null}
                    onChange={(next) => setExtra(row.key, { targetServiceId: next == null ? undefined : Number(next) })}
                    rowKey={(service) => service.serviceId}
                    rowCode={(service) => service.clientCode}
                    rowLabel={(service) => service.clientName}
                    emptyLabel="Nenhum serviço sem utilizador PPPoE"
                  />
                )}
                {!result && direction === 'ispm' && row.kind === 'only_router' && !row.managed && (
                  <Field
                    label={`Foi criado à mão no router. Escreva "${row.login}" para confirmar`}
                    value={extra.confirmName ?? ''}
                    onChange={(event) => setExtra(row.key, { confirmName: event.target.value })}
                    autoComplete="off"
                  />
                )}
                {!result && gap && <p className="router-muted">{gap}</p>}
              </li>
            );
          })}
        </ol>
      </Dialog>
    </>
  );
}
