import {
  Eye,
  EyeOff,
  Filter,
  Focus,
  ListTree,
  Minus,
  MoveHorizontal,
  MoveVertical,
  PanelRight,
  Plus,
  RadioTower,
  Search,
  X
} from 'lucide-react';
import type {
  TopologySearchResult
} from '../../../shared/topology';
import { Button, Field, Select } from '../../components';
import type { TopologyGraphFilters } from './topology-filters';
import type { TopologyDirection } from './topology-layout';

export type SearchState = 'idle' | 'loading' | 'error';

type TopologyToolbarProps = {
  query: string;
  searchState: SearchState;
  results: TopologySearchResult[];
  filters: TopologyGraphFilters;
  labelsVisible: boolean;
  legendVisible: boolean;
  inspectorVisible: boolean;
  direction: TopologyDirection;
  canManage: boolean;
  onCreateDevice: () => void;
  onQueryChange: (value: string) => void;
  onResultSelect: (result: TopologySearchResult) => void;
  onFiltersChange: (filters: TopologyGraphFilters) => void;
  onClearFilters: () => void;
  onToggleLabels: () => void;
  onToggleLegend: () => void;
  onToggleInspector: () => void;
  onToggleDirection: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
};

function SearchResults({
  query,
  state,
  results,
  onSelect
}: {
  query: string;
  state: SearchState;
  results: TopologySearchResult[];
  onSelect: (result: TopologySearchResult) => void;
}) {
  if (query.trim().length < 2) return null;
  return (
    <div className="topology-search-results" role="listbox" aria-label="Resultados da topologia">
      {state === 'loading' && <p role="status">A pesquisar na rede…</p>}
      {state === 'error' && <p role="alert">A pesquisa falhou. Tenta novamente.</p>}
      {state === 'idle' && results.length === 0 && <p>Nenhum resultado factual.</p>}
      {results.map((result) => (
        <Button
          variant="ghost"
          className="topology-search-result"
          role="option"
          aria-selected="false"
          aria-label={`Selecionar resultado ${result.node.label}`}
          key={result.node.id}
          onClick={() => onSelect(result)}
        >
          <span>
            <strong>{result.node.label}</strong>
            <small>
              {result.node.kind === 'backbone'
                ? 'Backbone físico'
                : result.node.parentId === 'root:isp'
                  ? 'CPE física · sem ligação definida'
                  : 'CPE física'}
            </small>
          </span>
          <em>{result.matchedFields.join(' · ')}</em>
        </Button>
      ))}
    </div>
  );
}

type FiltersProps = {
  filters: TopologyGraphFilters;
  onChange: (filters: TopologyGraphFilters) => void;
  onClear: () => void;
};

function StateFilter({ filters, onChange }: Omit<FiltersProps, 'onClear'>) {
  return (
    <Select
      label="Estado"
      value={filters.administrativeState ?? 'all'}
      onChange={(event) => onChange({
        ...filters,
        administrativeState: event.target.value === 'all'
          ? undefined
          : event.target.value as 'active' | 'inactive'
      })}
    >
      <option value="all">Todos</option>
      <option value="active">Ativo</option>
      <option value="inactive">Inativo</option>
    </Select>
  );
}

function AttentionFilter({ filters, onChange }: Omit<FiltersProps, 'onClear'>) {
  return (
    <Select
      label="Atenção"
      value={filters.attention === undefined ? 'all' : String(filters.attention)}
      onChange={(event) => onChange({
        ...filters,
        attention: event.target.value === 'all'
          ? undefined
          : event.target.value === 'true'
      })}
    >
      <option value="all">Todos</option>
      <option value="true">Com atenção</option>
      <option value="false">Sem atenção</option>
    </Select>
  );
}

function LocationFilters({ filters, onChange }: Omit<FiltersProps, 'onClear'>) {
  return (
    <>
      <Field
        label="Ilha"
        value={filters.island ?? ''}
        onChange={(event) => onChange({ ...filters, island: event.target.value || undefined })}
        placeholder="Ex.: Santiago"
      />
      <Field
        label="Zona"
        value={filters.zone ?? ''}
        onChange={(event) => onChange({ ...filters, zone: event.target.value || undefined })}
        placeholder="Ex.: Plateau"
      />
    </>
  );
}

function Filters({ filters, onChange, onClear }: FiltersProps) {
  return (
    <details className="topology-filter-menu">
      <summary><Filter size={14} aria-hidden /> Filtros</summary>
      <div className="topology-filter-fields">
        <StateFilter filters={filters} onChange={onChange} />
        <AttentionFilter filters={filters} onChange={onChange} />
        <LocationFilters filters={filters} onChange={onChange} />
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<X size={13} aria-hidden />}
          onClick={onClear}
        >
          Limpar filtros
        </Button>
        <small>Ilha e zona atuam sobre os ramos já carregados.</small>
      </div>
    </details>
  );
}

function CanvasTools(props: Pick<
  TopologyToolbarProps,
  | 'labelsVisible'
  | 'legendVisible'
  | 'inspectorVisible'
  | 'direction'
  | 'onToggleLabels'
  | 'onToggleLegend'
  | 'onToggleInspector'
  | 'onToggleDirection'
  | 'onZoomIn'
  | 'onZoomOut'
  | 'onFit'
>) {
  const vertical = props.direction === 'TB';
  return (
    <div className="topology-canvas-tools" role="toolbar" aria-label="Controlos do mapa">
      <Button variant="icon" onClick={props.onFit} aria-label="Ajustar mapa"><Focus size={15} /></Button>
      <Button variant="icon" onClick={props.onZoomOut} aria-label="Reduzir zoom"><Minus size={15} /></Button>
      <Button variant="icon" onClick={props.onZoomIn} aria-label="Aumentar zoom"><Plus size={15} /></Button>
      <span aria-hidden />
      <Button
        variant="icon"
        aria-pressed={props.labelsVisible}
        onClick={props.onToggleLabels}
        aria-label="Alternar etiquetas das ligações"
      >
        {props.labelsVisible ? <Eye size={15} /> : <EyeOff size={15} />}
      </Button>
      <Button
        variant="icon"
        aria-pressed={props.legendVisible}
        onClick={props.onToggleLegend}
        aria-label="Alternar legenda"
      >
        <ListTree size={15} />
      </Button>
      <Button
        variant="icon"
        aria-pressed={props.inspectorVisible}
        onClick={props.onToggleInspector}
        aria-label="Alternar inspetor"
      >
        <PanelRight size={15} />
      </Button>
      <Button
        variant="icon"
        onClick={props.onToggleDirection}
        aria-label={vertical
          ? 'Mudar para orientação horizontal'
          : 'Mudar para orientação vertical'}
      >
        {vertical ? <MoveHorizontal size={15} /> : <MoveVertical size={15} />}
      </Button>
    </div>
  );
}

export function TopologyToolbar(props: TopologyToolbarProps) {
  return (
    <div className="topology-toolbar">
      <div className="topology-search">
        <div className="topology-search-field">
          <Search size={15} aria-hidden />
          <Field
            hideLabel
            label="Pesquisar na topologia"
            id="topology-search-input"
            type="search"
            value={props.query}
            aria-label="Pesquisar na topologia"
            placeholder="Cliente, código, IP, MAC, serial…"
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
        </div>
        <SearchResults
          query={props.query}
          state={props.searchState}
          results={props.results}
          onSelect={props.onResultSelect}
        />
      </div>
      <Filters
        filters={props.filters}
        onChange={props.onFiltersChange}
        onClear={props.onClearFilters}
      />
      {props.canManage && (
        <Button
          variant="secondary"
          size="sm"
          className="topology-create-device"
          leadingIcon={<RadioTower size={14} aria-hidden />}
          onClick={props.onCreateDevice}
        >
          Novo equipamento
        </Button>
      )}
      <CanvasTools {...props} />
    </div>
  );
}
