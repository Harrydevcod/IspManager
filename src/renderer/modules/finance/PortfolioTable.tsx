import { useMemo, useState } from 'react';
import { Badge, Button, Card, DataTable, EmptyState, FilterBar } from '../../components';
import { compareNumber, compareText, sortRows, type SortState } from '../../lib/listView';
import { formatCve } from '../../lib/format';
import type { PortfolioReport, PortfolioRow } from '../../types';

type PortfolioSortKey =
  | 'fullName' | 'zone' | 'installationCostCve' | 'unrecoveredCve'
  | 'monthlyMarginCve' | 'monthsToBreakeven';

/**
 * Ordem de entrada: quem tem mais por devolver.
 *
 * A lista existe para uma decisao — quem cortar, quem nao voltar a instalar,
 * que zona nao compensa. Essa decisao le-se de cima para baixo, e no topo tem
 * de estar o cliente com mais dinheiro por devolver.
 */
const DEFAULT_SORT: SortState<PortfolioSortKey> = { key: 'unrecoveredCve', direction: 'desc' };

const COMPARATORS = {
  fullName: (a: PortfolioRow, b: PortfolioRow) => compareText(a.fullName, b.fullName),
  zone: (a: PortfolioRow, b: PortfolioRow) =>
    compareText(a.zone, b.zone) || compareText(a.fullName, b.fullName),
  installationCostCve: (a: PortfolioRow, b: PortfolioRow) =>
    compareNumber(a.installationCostCve, b.installationCostCve),
  unrecoveredCve: (a: PortfolioRow, b: PortfolioRow) =>
    compareNumber(a.unrecoveredCve, b.unrecoveredCve),
  monthlyMarginCve: (a: PortfolioRow, b: PortfolioRow) =>
    compareNumber(a.monthlyMarginCve, b.monthlyMarginCve),
  // Sem prazo previsto vai para o fim: nao e "zero meses", e "nunca, ao ritmo atual".
  monthsToBreakeven: (a: PortfolioRow, b: PortfolioRow) => compareNumber(
    a.monthsToBreakeven ?? Number.MAX_SAFE_INTEGER,
    b.monthsToBreakeven ?? Number.MAX_SAFE_INTEGER
  )
};

type PortfolioFilter = 'porRecuperar' | 'semMargem' | 'todos';

const FILTERS: Array<{ key: PortfolioFilter; label: string }> = [
  { key: 'porRecuperar', label: 'Por recuperar' },
  { key: 'semMargem', label: 'Sem margem' },
  { key: 'todos', label: 'Todos' }
];

function recoveryLabel(row: PortfolioRow) {
  if (row.installationCostCve <= 0) return '—';
  if (row.isRecovered) return 'Recuperado';
  if (row.monthsToBreakeven === null) return 'Sem prazo';
  return `${Math.ceil(row.monthsToBreakeven)} meses`;
}

export function PortfolioTable({ data, onOpenClient }: {
  data: PortfolioReport;
  onOpenClient?: (clientId: number) => void;
}) {
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [filter, setFilter] = useState<PortfolioFilter>('porRecuperar');

  const rows = useMemo(() => {
    const filtered = data.rows.filter((row) => {
      if (filter === 'porRecuperar') return row.installationCostCve > 0 && !row.isRecovered;
      if (filter === 'semMargem') return row.monthlyMarginCve <= 0;
      return true;
    });
    return sortRows(filtered, sort, COMPARATORS);
  }, [data.rows, filter, sort]);

  return (
    <Card
      eyebrow="Carteira"
      title="Capital por cliente"
      actions={(
        <FilterBar>
          {FILTERS.map((option) => (
            <Button
              key={option.key}
              variant="ghost"
              className={`segmented-tab${filter === option.key ? ' is-active' : ''}`}
              onClick={() => setFilter(option.key)}
            >
              {option.label}
            </Button>
          ))}
        </FilterBar>
      )}
    >
      <DataTable
        rows={rows}
        rowKey={(row) => row.clientId}
        sort={sort}
        onSortChange={setSort}
        stickyHeader
        onRowClick={onOpenClient ? (row) => onOpenClient(row.clientId) : undefined}
        gridTemplateColumns="minmax(200px, 1.4fr) 116px 124px 132px 124px 116px"
        empty={(
          <EmptyState
            title={filter === 'porRecuperar' ? 'Capital todo recuperado' : 'Nada nesta vista'}
            description={filter === 'porRecuperar'
              ? 'Todos os clientes com equipamento instalado já devolveram o que levaram.'
              : 'Nenhum cliente corresponde a este filtro.'}
          />
        )}
        columns={[
          {
            header: 'Cliente',
            sortKey: 'fullName',
            cell: (row) => (
              <span>
                <small className="entity-code">{row.clientCode || '—'}</small>
                <strong>{row.fullName}</strong>
                <small>{row.zone || 'sem zona'}</small>
              </span>
            )
          },
          { header: 'Zona', sortKey: 'zone', cell: (row) => row.zone || '—' },
          {
            header: 'Capital',
            sortKey: 'installationCostCve',
            defaultDirection: 'desc',
            align: 'end',
            cell: (row) => formatCve(row.installationCostCve)
          },
          {
            // Capital + OPEX acumulado por cobrir: e o que falta o cliente
            // entregar para deixar de dar prejuizo, nao so o preco da antena.
            header: 'Por recuperar',
            sortKey: 'unrecoveredCve',
            defaultDirection: 'desc',
            align: 'end',
            cell: (row) => (row.unrecoveredCve > 0
              ? <strong>{formatCve(row.unrecoveredCve)}</strong>
              : <Badge tone="success">Recuperado</Badge>)
          },
          {
            header: 'Margem/mês',
            sortKey: 'monthlyMarginCve',
            align: 'end',
            // Ja com o desgaste do equipamento descontado: e esta que se compara
            // entre clientes, porque nao depende do mes em que a antena subiu.
            cell: (row) => (row.monthlyMarginCve < 0
              ? <Badge tone="danger">{formatCve(row.monthlyMarginCve)}</Badge>
              : formatCve(row.monthlyMarginCve))
          },
          {
            header: 'Recupera em',
            sortKey: 'monthsToBreakeven',
            align: 'end',
            cell: (row) => recoveryLabel(row)
          }
        ]}
      />
    </Card>
  );
}
