import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Building2, Calculator, Download, Landmark, List, Pencil, Plus, Undo2, Vault, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorRetry,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  ModuleHeaderActions,
  Select,
  SkeletonList,
  useToast,
  type DataTableColumn
} from '../../components';
import { authFetch, useAuth } from '../../lib/auth';
import { downloadCsv } from '../../lib/csv';
import { formatCve, formatPtDate, formatPtMonth } from '../../lib/format';
import {
  ACCOUNT_KIND_LABEL,
  MOVEMENT_KIND_LABEL,
  TREASURY_API,
  type MovementKind,
  type TreasuryAccount,
  type TreasuryAccountKind,
  type TreasuryMovement,
  type TreasurySummary
} from '../../lib/treasury';
import { AccountDialog, CashCountDialog, ReverseMovementDialog, TransferDialog } from './TreasuryDialogs';
import './TreasuryModule.css';

type Tab = 'contas' | 'movimentos';

const MOVEMENT_TONE: Record<MovementKind, 'success' | 'danger' | 'info' | 'neutral' | 'accent' | 'warn'> = {
  recebimento: 'success',
  deposito: 'info',
  transferencia: 'info',
  despesa: 'danger',
  investimento: 'accent',
  ajuste: 'warn',
  estorno: 'neutral'
};

/** Só o que nasce na tesouraria se estorna aqui; o resto corrige-se na origem. */
const REVERSIBLE: MovementKind[] = ['deposito', 'transferencia', 'ajuste'];

function firstOfMonth() {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

const ACCOUNT_COLUMNS: DataTableColumn<TreasuryAccount>[] = [
  {
    header: 'Conta',
    sortValue: (a) => a.name,
    cell: (a) => <strong>{a.name}</strong>
  },
  {
    header: 'Tipo',
    sortValue: (a) => ACCOUNT_KIND_LABEL[a.kind],
    cell: (a) => (
      <span className="treasury-kind">
        {a.kind === 'caixa' ? <Vault size={14} aria-hidden /> : <Building2 size={14} aria-hidden />}
        {ACCOUNT_KIND_LABEL[a.kind]}
      </span>
    )
  },
  { header: 'Nº de conta', sortValue: (a) => a.accountNumber, cell: (a) => <code className="treasury-number">{a.accountNumber || '—'}</code> },
  // Sem os espaços com que foi escrito: 21 dígitos cabem na coluna, o valor
  // como o utilizador o escreveu fica no formulário da conta.
  { header: 'NIB', sortValue: (a) => a.nib, cell: (a) => <code className="treasury-number">{a.nib?.replace(/\s+/g, '') || '—'}</code> },
  {
    header: 'Estado',
    align: 'center',
    sortValue: (a) => (!a.active ? 'Desativada' : a.isDefaultCash ? 'Predefinida' : 'Ativa'),
    cell: (a) => (!a.active
      ? <Badge tone="neutral">Desativada</Badge>
      : a.isDefaultCash
        ? <Badge tone="accent">Predefinida</Badge>
        : a.showOnDocuments ? <Badge tone="info">Na fatura</Badge> : <Badge tone="success">Ativa</Badge>)
  },
  // Sem "Banco" nem "Últ. mov.": o nº de conta e o NIB precisam da largura toda
  // para não saírem truncados, e ambos continuam à mão — o banco no formulário
  // da conta, a data do último movimento na aba Movimentos.
  {
    header: 'Saldo',
    align: 'end',
    sortValue: (a) => a.balanceCve,
    defaultDirection: 'desc',
    cell: (a) => <b className={a.balanceCve < 0 ? 'treasury-negative' : undefined}>{formatCve(a.balanceCve)}</b>
  }
];

/**
 * Com uma conta filtrada (extrato) a coluna Conta repetia o mesmo nome em todas
 * as linhas: dá o lugar ao saldo corrido.
 */
function movementColumns(statement: boolean): DataTableColumn<TreasuryMovement>[] {
  const columns: DataTableColumn<TreasuryMovement>[] = [
    { header: 'Data', sortValue: (m) => `${m.movementDate} ${String(m.id).padStart(9, '0')}`, defaultDirection: 'desc', cell: (m) => <span>{formatPtDate(m.movementDate)}</span> }
  ];
  if (!statement) {
    columns.push({ header: 'Conta', sortValue: (m) => m.accountName, cell: (m) => <span>{m.accountName}</span> });
  }
  columns.push(
    {
      header: 'Tipo',
      align: 'center',
      sortValue: (m) => MOVEMENT_KIND_LABEL[m.kind],
      cell: (m) => <Badge tone={MOVEMENT_TONE[m.kind]}>{MOVEMENT_KIND_LABEL[m.kind]}</Badge>
    },
    {
      header: 'Descrição',
      sortValue: (m) => m.description,
      cell: (m) => (
        <span
          className={m.reversedById ? 'treasury-reversed' : undefined}
          title={`${m.reversedById ? '[Estornado] ' : ''}${m.description}${m.createdByName ? ` — por ${m.createdByName}` : ''}`}
        >
          {m.description}
        </span>
      )
    },
    { header: 'Referência', sortValue: (m) => m.reference, cell: (m) => <span>{m.reference || '—'}</span> },
    {
      header: 'Entrada',
      align: 'end',
      sortValue: (m) => (m.direction === 'in' ? m.amountCve : null),
      defaultDirection: 'desc',
      cell: (m) => (m.direction === 'in' ? <b className="treasury-in">{formatCve(m.amountCve)}</b> : <span>—</span>)
    },
    {
      header: 'Saída',
      align: 'end',
      sortValue: (m) => (m.direction === 'out' ? m.amountCve : null),
      defaultDirection: 'desc',
      cell: (m) => (m.direction === 'out' ? <b className="treasury-out">{formatCve(m.amountCve)}</b> : <span>—</span>)
    }
  );
  if (statement) {
    columns.push({
      header: 'Saldo',
      align: 'end',
      sortValue: (m) => m.balanceAfterCve,
      cell: (m) => (m.balanceAfterCve === undefined
        ? <span>—</span>
        : <b className={m.balanceAfterCve < 0 ? 'treasury-negative' : undefined}>{formatCve(m.balanceAfterCve)}</b>)
    });
  }
  return columns;
}

/**
 * Tesouraria: onde está o dinheiro.
 *
 * Caixas e bancos com saldo, o extrato de cada um, e as três operações que
 * mexem no dinheiro sem ser um pagamento ou uma despesa: depositar a caixa no
 * banco, transferir entre contas e contar a caixa. Os recebimentos entram aqui
 * sozinhos a partir do Financeiro; despesas e investimentos saem da conta que
 * lá se escolheu.
 */
export function TreasuryModule() {
  const { toast } = useToast();
  const auth = useAuth();
  const canOperate = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const isAdmin = auth.isAuthBypassed || auth.hasRole('admin');

  const [tab, setTab] = useState<Tab>('contas');
  const [summary, setSummary] = useState<TreasurySummary | null>(null);
  const [movements, setMovements] = useState<TreasuryMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [movementsLoading, setMovementsLoading] = useState(false);

  const [accountFilter, setAccountFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<'' | MovementKind>('');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState('');

  const [accountDialog, setAccountDialog] = useState<{ kind: TreasuryAccountKind; account: TreasuryAccount | null } | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<TreasuryMovement | null>(null);

  const accounts = useMemo(() => summary?.accounts ?? [], [summary]);

  const loadSummary = useCallback(async () => {
    try {
      const response = await authFetch(`${TREASURY_API}/summary`);
      if (!response.ok) throw new Error('summary');
      setSummary(await response.json() as TreasurySummary);
      setLoadError(null);
    } catch {
      setLoadError('Não foi possível carregar a tesouraria.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMovements = useCallback(async () => {
    setMovementsLoading(true);
    const params = new URLSearchParams();
    if (accountFilter) params.set('accountId', accountFilter);
    if (kindFilter) params.set('kind', kindFilter);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    try {
      const response = await authFetch(`${TREASURY_API}/movements?${params.toString()}`);
      setMovements(response.ok ? await response.json() as TreasuryMovement[] : []);
    } finally {
      setMovementsLoading(false);
    }
  }, [accountFilter, kindFilter, from, to]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { if (tab === 'movimentos') void loadMovements(); }, [tab, loadMovements]);

  async function afterSave(message: string) {
    toast(message, 'success');
    setAccountDialog(null);
    setTransferOpen(false);
    setCountOpen(false);
    setReverseTarget(null);
    await loadSummary();
    if (tab === 'movimentos') await loadMovements();
  }

  function openStatement(account: TreasuryAccount) {
    setAccountFilter(String(account.id));
    setKindFilter('');
    setFrom(account.openingDate);
    setTo('');
    setTab('movimentos');
  }

  const withBalance = Boolean(accountFilter);
  const columns = useMemo(() => movementColumns(withBalance), [withBalance]);
  const selectedAccount = accounts.find((a) => String(a.id) === accountFilter);
  const periodIn = movements.reduce((sum, m) => sum + (m.direction === 'in' ? m.amountCve : 0), 0);
  const periodOut = movements.reduce((sum, m) => sum + (m.direction === 'out' ? m.amountCve : 0), 0);
  const hasCash = accounts.some((a) => a.active && a.kind === 'caixa');

  function exportCsv() {
    const header = ['Data', 'Conta', 'Tipo', 'Descrição', 'Referência', 'Por', 'Entrada', 'Saída', ...(withBalance ? ['Saldo'] : [])];
    downloadCsv(`tesouraria-${selectedAccount ? selectedAccount.name.replace(/\s+/g, '-').toLowerCase() : 'movimentos'}-${from || 'inicio'}.csv`, [
      header,
      ...movements.map((m) => [
        m.movementDate,
        m.accountName,
        MOVEMENT_KIND_LABEL[m.kind],
        m.description,
        m.reference,
        m.createdByName,
        m.direction === 'in' ? m.amountCve : null,
        m.direction === 'out' ? m.amountCve : null,
        ...(withBalance ? [m.balanceAfterCve ?? null] : [])
      ])
    ]);
  }

  return (
    <section className="module-panel treasury-module">
      <div className="module-header">
        <div>
          <p className="eyebrow">Módulo</p>
          <h2>Tesouraria</h2>
          <p className="treasury-subtitle">Caixas, bancos e para onde vai cada escudo recebido.</p>
        </div>
        {canOperate && (
          <ModuleHeaderActions
            ariaLabel="Ações da tesouraria"
            secondary={
              <>
                <Button variant="secondary" leadingIcon={<Calculator size={16} aria-hidden />} disabled={!hasCash} onClick={() => setCountOpen(true)}>
                  Contar caixa
                </Button>
                {isAdmin && (
                  <>
                    <Button variant="secondary" leadingIcon={<Plus size={16} aria-hidden />} onClick={() => setAccountDialog({ kind: 'caixa', account: null })}>
                      Nova caixa
                    </Button>
                    <Button variant="secondary" leadingIcon={<Plus size={16} aria-hidden />} onClick={() => setAccountDialog({ kind: 'banco', account: null })}>
                      Nova conta bancária
                    </Button>
                  </>
                )}
              </>
            }
            primary={
              <Button leadingIcon={<ArrowLeftRight size={16} aria-hidden />} disabled={accounts.filter((a) => a.active).length < 2} onClick={() => setTransferOpen(true)}>
                Depositar / transferir
              </Button>
            }
          />
        )}
      </div>

      {loadError && !summary && <ErrorRetry message={loadError} onRetry={() => { void loadSummary(); }} />}

      {summary && (
        <MetricGrid label="Saldos">
          <MetricCard icon={Wallet} label="Saldo total" value={formatCve(summary.totalCve)} trend={`${accounts.filter((a) => a.active).length} contas ativas`} tone="revenue" />
          <MetricCard
            icon={Vault}
            label="Em caixa"
            value={formatCve(summary.cashCve)}
            trend={summary.cashCve > 0 ? 'numerário por depositar' : 'nada por depositar'}
            tone={summary.cashCve > 0 ? 'warning' : 'neutral'}
            onActivate={summary.cashCve > 0 && canOperate ? () => setTransferOpen(true) : undefined}
          />
          <MetricCard icon={Landmark} label="Em bancos" value={formatCve(summary.bankCve)} trend={`${accounts.filter((a) => a.active && a.kind === 'banco').length} contas bancárias`} tone="info" />
          <MetricCard
            icon={summary.monthInCve >= summary.monthOutCve ? ArrowDownLeft : ArrowUpRight}
            label={`Fluxo de ${formatPtMonth(summary.month)}`}
            value={formatCve(summary.monthInCve - summary.monthOutCve)}
            trend={`entrou ${formatCve(summary.monthInCve)} · saiu ${formatCve(summary.monthOutCve)}`}
            tone={summary.monthInCve >= summary.monthOutCve ? 'success' : 'danger'}
          />
        </MetricGrid>
      )}

      <nav className="segmented-tabs" role="tablist" aria-label="Tesouraria">
        <Button variant="ghost" role="tab" aria-selected={tab === 'contas'} className={`segmented-tab${tab === 'contas' ? ' is-active' : ''}`} onClick={() => setTab('contas')}>
          <Landmark size={14} aria-hidden />
          <span>Contas</span>
          <span className="segmented-tab-count">{accounts.length}</span>
        </Button>
        <Button variant="ghost" role="tab" aria-selected={tab === 'movimentos'} className={`segmented-tab${tab === 'movimentos' ? ' is-active' : ''}`} onClick={() => setTab('movimentos')}>
          <List size={14} aria-hidden />
          <span>Movimentos</span>
        </Button>
      </nav>

      {tab === 'contas' && (
        loading && !summary ? <SkeletonList rows={4} /> : (
          <DataTable
            rows={accounts}
            rowKey={(a) => a.id}
            stickyHeader
            onRowClick={openStatement}
            defaultSort={{ key: 'Tipo', direction: 'asc' }}
            gridTemplateColumns="minmax(88px, 1fr) 66px minmax(122px, 1fr) minmax(190px, 2fr) 100px minmax(76px, 0.8fr)"
            actionsWidth="48px"
            columns={ACCOUNT_COLUMNS}
            actions={isAdmin ? (account) => (
              <Button variant="icon" size="sm" className="row-action" title="Editar conta" aria-label={`Editar ${account.name}`} onClick={() => setAccountDialog({ kind: account.kind, account })}>
                <Pencil size={14} aria-hidden />
              </Button>
            ) : undefined}
            empty={
              <EmptyState icon={Landmark} title="Sem contas" description="Crie a primeira caixa ou conta bancária." />
            }
          />
        )
      )}

      {tab === 'movimentos' && (
        <>
          <div className="treasury-filter-sticky">
            <FilterBar>
              <Select label="Conta" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
                <option value="">Todas</option>
                {accounts.map((a) => <option key={a.id} value={String(a.id)}>{a.name}{a.active ? '' : ' (desativada)'}</option>)}
              </Select>
              <Select label="Tipo" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as '' | MovementKind)}>
                <option value="">Todos</option>
                {(Object.keys(MOVEMENT_KIND_LABEL) as MovementKind[]).map((kind) => (
                  <option key={kind} value={kind}>{MOVEMENT_KIND_LABEL[kind]}</option>
                ))}
              </Select>
              <Field label="De" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              <Field label="Até" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              <Button variant="secondary" onClick={() => { setAccountFilter(''); setKindFilter(''); setFrom(firstOfMonth()); setTo(''); }}>
                Limpar filtros
              </Button>
              <Button variant="secondary" leadingIcon={<Download size={16} aria-hidden />} disabled={movements.length === 0} onClick={exportCsv}>
                CSV
              </Button>
              <small>
                {movements.length} {movements.length === 1 ? 'movimento' : 'movimentos'} · entrou {formatCve(periodIn)} · saiu {formatCve(periodOut)}
              </small>
            </FilterBar>
          </div>

          {movementsLoading && movements.length === 0 ? <SkeletonList rows={6} /> : (
            <DataTable
              rows={movements}
              rowKey={(m) => m.id}
              stickyHeader
              defaultSort={{ key: 'Data', direction: 'desc' }}
              gridTemplateColumns={`82px ${withBalance ? '' : 'minmax(84px, 0.8fr) '}100px minmax(130px, 2fr) minmax(64px, 0.6fr) 96px 96px${withBalance ? ' 104px' : ''}`}
              actionsWidth="56px"
              columns={columns}
              actions={isAdmin ? (m) => (REVERSIBLE.includes(m.kind) && !m.reversedById ? (
                <Button variant="icon" size="sm" className="row-action" title="Estornar" aria-label={`Estornar ${m.description}`} onClick={() => setReverseTarget(m)}>
                  <Undo2 size={14} aria-hidden />
                </Button>
              ) : null) : undefined}
              empty={
                <EmptyState
                  icon={List}
                  title="Sem movimentos neste período"
                  description="Os recebimentos, depósitos e despesas pagas por uma conta aparecem aqui."
                />
              }
            />
          )}
        </>
      )}

      {accountDialog && (
        <AccountDialog
          open
          kind={accountDialog.kind}
          account={accountDialog.account}
          onClose={() => setAccountDialog(null)}
          onSaved={(message) => void afterSave(message)}
        />
      )}
      <TransferDialog
        open={transferOpen}
        accounts={accounts}
        initialFromId={selectedAccount?.id}
        isAdmin={isAdmin}
        onClose={() => setTransferOpen(false)}
        onSaved={(message) => void afterSave(message)}
      />
      <CashCountDialog
        open={countOpen}
        accounts={accounts}
        initialAccountId={selectedAccount?.kind === 'caixa' ? selectedAccount.id : null}
        onClose={() => setCountOpen(false)}
        onSaved={(message) => void afterSave(message)}
      />
      <ReverseMovementDialog movement={reverseTarget} onClose={() => setReverseTarget(null)} onSaved={(message) => void afterSave(message)} />
    </section>
  );
}
