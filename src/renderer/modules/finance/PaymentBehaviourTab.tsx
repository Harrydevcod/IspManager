import { apiUrl } from '../../lib/api';
import { CalendarCheck, Gauge, ThumbsUp, TrendingDown } from 'lucide-react';
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
  FINANCIAL_STATE_LABELS, PAYMENT_CLASS_LETTERS, PAYMENT_CONFIDENCE_LABELS,
  PUNCTUALITY_SCALE_LABELS, type PaymentClass
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
    header: 'Pontuação',
    align: 'center',
    sortValue: (c) => (c.letter === null ? null : c.score),
    defaultDirection: 'desc',
    cell: (c) => (c.letter === null ? <span>—</span> : <b>{c.score}</b>)
  },
  {
    // A coluna que impede o mal-entendido: um 100 tirado de uma mensalidade não
    // é o mesmo juízo que um 100 tirado de doze. Ordena pelo número de
    // mensalidades, que é a grandeza por baixo do rótulo.
    header: 'Confiança',
    align: 'center',
    sortValue: (c) => (c.confidence === null ? null : c.evaluated),
    defaultDirection: 'desc',
    cell: (c) => (
      c.confidence === null
        ? <span>—</span>
        : <span title={`${c.evaluated} mensalidades avaliadas`}>{PAYMENT_CONFIDENCE_LABELS[c.confidence]}</span>
    )
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
 * A 1225 px (o ecrã real, 1920 a 150%) a tabela dispõe de 918 px, e as onze
 * colunas pedem bem mais — as últimas ficavam fora do ecrã, sem forma de lá
 * chegar. Estas quatro são as que menos pesam na decisão de quem cobra: o nome
 * identifica melhor do que o código, e a pontualidade, o atraso médio e o
 * número de mensalidades detalham um juízo que a classe, a pontuação e a
 * confiança já resumem. Num monitor maior voltam num clique, em "Colunas".
 */
const DEFAULT_HIDDEN = ['Código', 'Pontualidade', 'Atraso médio', 'Avaliadas'];

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
      const response = await authFetch(apiUrl('/api/finance/payment-behaviour'));
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
          trend={`${totals?.alwaysOnTimePct || 0}% nunca pagaram tarde`}
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
          icon={TrendingDown}
          label="A piorar"
          value={String(totals?.declining || 0)}
          trend={`${totals?.improving || 0} a melhorar`}
          tone={totals?.declining ? 'warning' : 'neutral'}
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
          disabled={!totals?.awaiting}
        >
          Aguarda avaliação ({totals?.awaiting || 0})
        </Button>
        <ColumnPicker
          headers={HEADERS}
          hidden={columnVisibility.hidden}
          onToggle={columnVisibility.toggle}
          onReset={columnVisibility.reset}
        />
        {/* Sem isto as letras não se explicam a quem não abriu as Configurações. */}
        {report && (
          <span
            className="behaviour-scale"
            title="Escala da pontualidade e atraso médio que vale zero — Configurações › Faturação"
          >
            {PUNCTUALITY_SCALE_LABELS[report.rules.scale]} · atraso {report.rules.delayLimitDays} d
          </span>
        )}
      </FilterBar>

      <DataTable<ClientBehaviour>
        rows={rows}
        rowKey={(c) => c.clientId}
        defaultSort={{ key: 'Pontuação', direction: 'desc' }}
        onRowClick={onOpenClient ? (c) => onOpenClient(c.clientId) : undefined}
        // Cliente encolhe com reticências; o resto tem a largura do seu dado.
        gridTemplateColumns="80px minmax(140px, 1.4fr) 116px 92px 116px 76px 116px 112px 96px 100px 112px"
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
