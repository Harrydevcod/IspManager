import { CalendarCheck, Gauge, ThumbsUp, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, ColumnPicker, DataTable, EmptyState, ErrorRetry,
  FilterBar, MetricCard, MetricGrid, SkeletonList
} from '../../components';
import type { DataTableColumn } from '../../components/DataTable';
import { authFetch } from '../../lib/auth';
import { useColumnVisibility } from '../../lib/columnVisibility';
import { formatCve } from '../../lib/format';
import {
  FINANCIAL_STATE_LABELS, PAYMENT_CLASS_LETTERS, PUNCTUALITY_SCALE_LABELS,
  type PaymentClass
} from '../../../shared/payment-score';
import type { ClientBehaviour, PaymentBehaviourReport } from '../../types';
import { ScorePill, TrendIcon } from './ScorePill';

/**
 * Comportamento: de quem é que se pode confiar.
 *
 * Pendentes diz quanto cada cliente deve hoje. Esta vista diz o que ele costuma
 * fazer — quem atrasou dez vezes e acabou por pagar deixa de ser igual a quem
 * nunca atrasou. A letra sai do histórico de mensalidades; o estado ao lado é o
 * de hoje, e os dois não se misturam de propósito.
 *
 * Sem cache, como o resto da cobrança: deriva-se das faturas a cada pedido.
 */

const STATE_TONE: Record<ClientBehaviour['state'], 'success' | 'danger' | 'warn'> = {
  em_dia: 'success',
  vencido: 'danger',
  suspenso: 'warn'
};

const COLUMNS: DataTableColumn<ClientBehaviour>[] = [
  {
    header: 'Código',
    sortValue: (c) => c.clientCode,
    cell: (c) => <span className="entity-code">{c.clientCode || '—'}</span>
  },
  {
    header: 'Cliente',
    sortValue: (c) => c.clientName,
    cell: (c) => <strong title={c.clientName}>{c.clientName}</strong>
  },
  {
    header: 'Classe',
    sortValue: (c) => (c.letter === null ? null : c.score),
    defaultDirection: 'desc',
    cell: (c) => <ScorePill letter={c.letter} />
  },
  {
    // Sem histórico não leva pontuação: com uma mensalidade paga a horas a
    // conta chega a 100 (os meses sem fatura contam limpos) e um 100 ao lado de
    // "Sem histórico" abria a lista com o cliente que menos se conhece.
    // Quantas mensalidades sustentam o número está na coluna Avaliadas.
    header: 'Pontuação',
    align: 'center',
    sortValue: (c) => (c.provisional ? null : c.score),
    defaultDirection: 'desc',
    cell: (c) => (c.provisional ? <span>—</span> : <b>{c.score}</b>)
  },
  {
    header: 'Tendência',
    align: 'center',
    sortValue: (c) => c.trend,
    cell: (c) => <TrendIcon trend={c.trend} />
  },
  {
    header: 'Pontualidade',
    align: 'center',
    sortValue: (c) => (c.evaluated === 0 ? null : c.punctualityPct),
    defaultDirection: 'desc',
    cell: (c) => (c.evaluated === 0 ? <span>—</span> : <span>{c.punctualityPct}%</span>)
  },
  {
    header: 'Atraso médio',
    align: 'center',
    sortValue: (c) => (c.evaluated === 0 ? null : c.avgDelayDays),
    defaultDirection: 'desc',
    cell: (c) => (c.evaluated === 0 ? <span>—</span> : <span>{c.avgDelayDays} d</span>)
  },
  {
    header: 'Avaliadas',
    align: 'center',
    sortValue: (c) => c.evaluated,
    defaultDirection: 'desc',
    cell: (c) => <span>{c.evaluated}</span>
  },
  {
    header: 'Estado',
    align: 'center',
    sortValue: (c) => c.state,
    cell: (c) => <Badge tone={STATE_TONE[c.state]}>{FINANCIAL_STATE_LABELS[c.state]}</Badge>
  },
  {
    header: 'Vencido',
    align: 'end',
    sortValue: (c) => (c.overdueCve > 0 ? c.overdueCve : null),
    defaultDirection: 'desc',
    cell: (c) => <span>{c.overdueCve > 0 ? formatCve(c.overdueCve) : '—'}</span>
  }
];

const HEADERS = COLUMNS.map((column) => column.header);

/**
 * A 1225 px (o ecrã real, 1920 a 150%) a tabela dispõe de 918 px, e as dez
 * colunas pedem 1178 — Estado e Vencido ficavam fora do ecrã, sem forma de lá
 * chegar. Estas três são as que menos pesam na decisão de quem cobra: o nome
 * identifica melhor do que o código, e a pontualidade e o número de
 * mensalidades detalham um juízo que a classe já resume. Num monitor maior
 * voltam num clique, em "Colunas".
 */
const DEFAULT_HIDDEN = ['Código', 'Pontualidade', 'Avaliadas'];

type Filter = PaymentClass | 'all' | 'none';

export function PaymentBehaviourTab({ onOpenClient }: { onOpenClient?: (clientId: number) => void } = {}) {
  const [report, setReport] = useState<PaymentBehaviourReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const columnVisibility = useColumnVisibility('ispm.finance.behaviour.hiddenColumns', HEADERS, DEFAULT_HIDDEN);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/finance/payment-behaviour');
      if (!response.ok) {
        setLoadError('Não foi possível carregar o comportamento de pagamento.');
        return;
      }
      setReport(await response.json() as PaymentBehaviourReport);
      setLoadError(null);
    } catch {
      setLoadError('Não foi possível carregar o comportamento de pagamento.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const all = report?.clients || [];
    if (filter === 'all') return all;
    if (filter === 'none') return all.filter((c) => c.letter === null);
    return all.filter((c) => c.letter === filter);
  }, [report, filter]);

  if (loadError && !report) {
    return <ErrorRetry message={loadError} onRetry={() => { void load(); }} />;
  }

  if (loading && !report) {
    return <SkeletonList rows={6} />;
  }

  const totals = report?.totals;
  const distribution = totals?.distribution;
  // Bons pagadores: as duas letras de cima. É o número que abre uma campanha.
  const trusted = (distribution?.A || 0) + (distribution?.B || 0);
  const watch = (distribution?.D || 0) + (distribution?.E || 0);

  return (
    <div className="behaviour-module">
      <MetricGrid label="Comportamento de pagamento">
        <MetricCard
          icon={Gauge}
          label="Pontuação média"
          value={String(totals?.avgScore || 0)}
          trend={`${totals?.classified || 0} clientes classificados`}
          tone="revenue"
        />
        <MetricCard
          icon={ThumbsUp}
          label="Bons pagadores"
          value={String(trusted)}
          trend="classes A e B"
          tone="success"
        />
        <MetricCard
          icon={CalendarCheck}
          label="Em dia hoje"
          value={`${totals?.inGoodStandingPct || 0}%`}
          trend={`${watch} a precisar de acompanhamento`}
          tone={watch > 0 ? 'warning' : 'info'}
        />
        <MetricCard
          icon={UserPlus}
          label="Sem histórico"
          value={String(totals?.provisional || 0)}
          trend="menos de três mensalidades"
          tone="neutral"
        />
      </MetricGrid>

      <FilterBar>
        <Button
          variant="ghost"
          className={`segmented-tab${filter === 'all' ? ' is-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          Todos
        </Button>
        {PAYMENT_CLASS_LETTERS.map((letter) => {
          const count = distribution?.[letter] || 0;
          return (
            <Button
              key={letter}
              variant="ghost"
              className={`segmented-tab${filter === letter ? ' is-active' : ''}`}
              onClick={() => setFilter(letter)}
              disabled={!count}
            >
              {letter} ({count})
            </Button>
          );
        })}
        <Button
          variant="ghost"
          className={`segmented-tab${filter === 'none' ? ' is-active' : ''}`}
          onClick={() => setFilter('none')}
          disabled={!totals?.provisional}
        >
          Sem histórico ({totals?.provisional || 0})
        </Button>
        <ColumnPicker
          headers={HEADERS}
          hidden={columnVisibility.hidden}
          onToggle={columnVisibility.toggle}
          onReset={columnVisibility.reset}
        />
        {/* Sem isto as letras não se explicam a quem não abriu as Configurações. */}
        {report && (
          <span className="behaviour-scale" title="Configurações › Faturação">
            Escala {PUNCTUALITY_SCALE_LABELS[report.scale].toLowerCase()}
          </span>
        )}
      </FilterBar>

      <DataTable<ClientBehaviour>
        rows={rows}
        rowKey={(c) => c.clientId}
        defaultSort={{ key: 'Pontuação', direction: 'desc' }}
        onRowClick={onOpenClient ? (c) => onOpenClient(c.clientId) : undefined}
        // Cliente encolhe com reticências; o resto tem a largura do seu dado.
        gridTemplateColumns="80px minmax(140px, 1.4fr) 116px 92px 76px 116px 112px 96px 100px 112px"
        empty={
          <EmptyState
            title="Sem classificações"
            description={
              filter === 'all'
                ? 'Nenhum cliente tem mensalidades vencidas para avaliar.'
                : 'Nenhum cliente nesta classe.'
            }
          />
        }
        columns={COLUMNS}
        hiddenColumns={columnVisibility.hidden}
      />
    </div>
  );
}
