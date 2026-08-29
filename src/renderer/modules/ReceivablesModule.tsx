import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock, Users, Wallet } from 'lucide-react';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorRetry,
  FilterBar,
  MetricCard,
  MetricGrid,
  SkeletonList
} from '../components';
import { authFetch } from '../lib/auth';
import { formatCve, formatPtDate } from '../lib/format';
import { compareNumber, compareText, sortRows, type SortState } from '../lib/listView';
import { AGING_LABELS, type AgingBucket, type ReceivableClient, type ReceivablesReport } from '../types';

/**
 * Pendentes: a vista de cobranca.
 *
 * Responde a pergunta que o modulo de Pagamentos, organizado por fatura, nao
 * responde — quem deve, quanto, e ha quanto tempo. O numero em toda a parte e o
 * SALDO: uma fatura de 50.000 com 40.000 recebidos entra aqui por 10.000.
 *
 * Sem cache: e uma lista para ter aberta enquanto se liga aos clientes, e um
 * valor de ha cinco minutos numa conversa de cobranca e pior do que nenhum.
 */

type ReceivablesSortKey = 'clientName' | 'openCve' | 'oldestDueDate' | 'maxDaysOverdue';

const BUCKET_TONE: Record<AgingBucket, 'success' | 'info' | 'warn' | 'danger' | 'neutral'> = {
  current: 'info',
  d30: 'warn',
  d60: 'warn',
  d90: 'danger',
  d90plus: 'danger'
};

const BUCKET_ORDER: AgingBucket[] = ['current', 'd30', 'd60', 'd90', 'd90plus'];

export function ReceivablesModule({ onOpenClient }: { onOpenClient?: (clientId: number) => void } = {}) {
  const [report, setReport] = useState<ReceivablesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bucketFilter, setBucketFilter] = useState<AgingBucket | 'all'>('all');
  const [sort, setSort] = useState<SortState<ReceivablesSortKey>>({ key: 'openCve', direction: 'desc' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/receivables');
      if (!response.ok) {
        setLoadError('Nao foi possivel carregar os pendentes.');
        return;
      }
      setReport(await response.json() as ReceivablesReport);
      setLoadError(null);
    } catch {
      setLoadError('Nao foi possivel carregar os pendentes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const all = report?.clients || [];
    const filtered = bucketFilter === 'all' ? all : all.filter((c) => c.bucket === bucketFilter);
    return sortRows(filtered, sort, {
      clientName: (a, b) => compareText(a.clientName, b.clientName),
      openCve: (a, b) => compareNumber(a.openCve, b.openCve),
      oldestDueDate: (a, b) => compareText(a.oldestDueDate, b.oldestDueDate),
      maxDaysOverdue: (a, b) => compareNumber(a.maxDaysOverdue, b.maxDaysOverdue)
    });
  }, [report, bucketFilter, sort]);

  if (loadError && !report) {
    return <ErrorRetry message={loadError} onRetry={() => { void load(); }} />;
  }

  if (loading && !report) {
    return <SkeletonList rows={6} />;
  }

  const totals = report?.totals;

  return (
    <div className="receivables-module">
      <MetricGrid label="Cobranca">
        <MetricCard
          icon={Wallet}
          label="Em aberto"
          value={formatCve(totals?.openCve || 0)}
          trend={`${totals?.invoices || 0} faturas`}
          tone="revenue"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Vencido"
          value={formatCve(totals?.overdueCve || 0)}
          trend={`por vencer ${formatCve(totals?.notDueCve || 0)}`}
          tone="danger"
        />
        <MetricCard
          icon={Users}
          label="Clientes com divida"
          value={String(totals?.clients || 0)}
          tone="neutral"
        />
        <MetricCard
          icon={Clock}
          label="Credito em circulacao"
          value={formatCve(totals?.creditCve || 0)}
          trend="a abater na proxima fatura"
          tone="info"
        />
      </MetricGrid>

      <FilterBar>
        <Button
          variant="ghost"
          className={`segmented-tab${bucketFilter === 'all' ? ' is-active' : ''}`}
          onClick={() => setBucketFilter('all')}
        >
          Todos
        </Button>
        {BUCKET_ORDER.map((bucket) => {
          const stats = report?.aging?.[bucket];
          return (
            <Button
              key={bucket}
              variant="ghost"
              className={`segmented-tab${bucketFilter === bucket ? ' is-active' : ''}`}
              onClick={() => setBucketFilter(bucket)}
              disabled={!stats?.invoices}
              title={stats ? `${stats.invoices} faturas · ${formatCve(stats.amountCve)}` : undefined}
            >
              {AGING_LABELS[bucket]} ({stats?.invoices || 0})
            </Button>
          );
        })}
      </FilterBar>

      <DataTable<ReceivableClient, ReceivablesSortKey>
        rows={rows}
        rowKey={(c) => c.clientId}
        sort={sort}
        onSortChange={setSort}
        onRowClick={onOpenClient ? (c) => onOpenClient(c.clientId) : undefined}
        gridTemplateColumns="minmax(200px, 1fr) 96px 128px 140px 128px"
        empty={
          <EmptyState
            title="Nada por cobrar"
            description={
              bucketFilter === 'all'
                ? 'Nenhum cliente tem faturas com saldo em aberto.'
                : 'Nenhum cliente neste intervalo de antiguidade.'
            }
          />
        }
        columns={[
          {
            header: 'Cliente',
            sortKey: 'clientName',
            cell: (c) => (
              <span>
                <small className="entity-code">{c.clientCode || '—'}</small>
                <strong>{c.clientName}</strong>
                <small>{[c.zone, c.phone].filter(Boolean).join(' · ') || 'sem contacto'}</small>
              </span>
            )
          },
          {
            header: 'Faturas',
            align: 'center',
            cell: (c) => <span>{c.invoices}</span>
          },
          {
            header: 'Mais antiga',
            sortKey: 'oldestDueDate',
            cell: (c) => <span>{formatPtDate(c.oldestDueDate)}</span>
          },
          {
            header: 'Antiguidade',
            sortKey: 'maxDaysOverdue',
            align: 'center',
            cell: (c) => <Badge tone={BUCKET_TONE[c.bucket]}>{AGING_LABELS[c.bucket]}</Badge>
          },
          {
            header: 'Em aberto',
            sortKey: 'openCve',
            defaultDirection: 'desc',
            align: 'end',
            // O credito aparece por baixo do saldo porque muda a conversa: nao
            // se liga a cobrar a quem ja tem dinheiro nosso a favor.
            cell: (c) => (
              <span>
                <b>{formatCve(c.openCve)}</b>
                {c.creditCve > 0 && <small>crédito {formatCve(c.creditCve)}</small>}
              </span>
            )
          }
        ]}
      />
    </div>
  );
}
