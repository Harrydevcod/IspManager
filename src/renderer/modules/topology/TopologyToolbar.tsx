import {
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Filter,
  Focus,
  ListTree,
  Map,
  Minus,
  MoveHorizontal,
  MoveVertical,
  PanelRight,
  Plus,
  RadioTower,
  RotateCw,
  Search,
  X
} from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  TopologyBackboneNode,
  TopologySearchResult
} from '../../../shared/topology';
import { Button, Field, Select } from '../../components';
import { CV_ISLANDS } from '../../lib/islands';
import type { TopologyGraphFilters } from './topology-filters';
import type { TopologyDirection } from './topology-layout';

export type SearchState = 'idle' | 'loading' | 'error';

/** O que se controla sobre o mapa — mora na tira das abas, não sobre o canvas. */
export type CanvasToolsProps = {
  labelsVisible: boolean;
  legendVisible: boolean;
  minimapVisible: boolean;
  inspectorVisible: boolean;
  allBranchesExpanded: boolean;
  hasBackbones: boolean;
  direction: TopologyDirection;
  refreshing: boolean;
  onRefresh: () => void;
  onToggleLabels: () => void;
  onToggleLegend: () => void;
  onToggleMinimap: () => void;
  onToggleInspector: () => void;
  onToggleDirection: () => void;
  onToggleAllBranches: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
};

type TopologyToolbarProps = {
  query: string;
  searchState: SearchState;
  results: TopologySearchResult[];
  filters: TopologyGraphFilters;
  backbones: TopologyBackboneNode[];
  focusedBackboneId: number | null;
  onFocusBackbone: (backboneDeviceId: number | null) => void;
  canManage: boolean;
  onCreateDevice: () => void;
  onQueryChange: (value: string) => void;
  onResultSelect: (result: TopologySearchResult) => void;
  onFiltersChange: (filters: TopologyGraphFilters) => void;
  onClearFilters: () => void;
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
      {/* Grafias antigas continuam a ser apanhadas: o filtro compara texto
          normalizado dos dois lados (topology-filters.ts). */}
      <Select
        label="Ilha"
        value={filters.island ?? ''}
        onChange={(event) => onChange({ ...filters, island: event.target.value || undefined })}
      >
        <option value="">Todas</option>
        {CV_ISLANDS.map((island) => (
          <option key={island} value={island}>{island}</option>
        ))}
      </Select>
      <Field
        label="Zona"
        value={filters.zone ?? ''}
        onChange={(event) => onChange({ ...filters, zone: event.target.value || undefined })}
        placeholder="Ex.: Plateau"
      />
    </>
  );
}

/**
 * A rede inteira não cabe legível num ecrã. Este seletor troca-a por uma antena
 * de cada vez — o backbone, o que pende dele e a cadeia até à Internet.
 */
function ViewScope({ backbones, focusedBackboneId, onFocusBackbone }: Pick<
  TopologyToolbarProps,
  'backbones' | 'focusedBackboneId' | 'onFocusBackbone'
>) {
  // Com um backbone só não há por onde dividir.
  if (backbones.length < 2) return null;
  return (
    <div className="topology-scope">
      <Select
        aria-label="Vista do mapa"
        value={focusedBackboneId === null ? 'all' : String(focusedBackboneId)}
        onChange={(event) => onFocusBackbone(
          event.target.value === 'all' ? null : Number(event.target.value)
        )}
      >
        <option value="all">Rede completa</option>
        {backbones.map((backbone) => (
          <option key={backbone.id} value={backbone.backboneDeviceId}>
            {backbone.label}
          </option>
        ))}
      </Select>
    </div>
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

/**
 * O rótulo entra uma vez e sai nos dois sítios: `aria-label` para quem ouve,
 * `title` para quem passa o rato. Duas strings à mão acabariam por divergir.
 */
function ToolButton({ label, pressed, disabled, onClick, children }: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="icon"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function CanvasTools(props: CanvasToolsProps) {
  const vertical = props.direction === 'TB';
  return (
    <div className="topology-canvas-tools" role="toolbar" aria-label="Controlos do mapa">
      <ToolButton label="Ajustar o mapa à vista" onClick={props.onFit}>
        <Focus size={15} />
      </ToolButton>
      <ToolButton label="Reduzir zoom" onClick={props.onZoomOut}>
        <Minus size={15} />
      </ToolButton>
      <ToolButton label="Aumentar zoom" onClick={props.onZoomIn}>
        <Plus size={15} />
      </ToolButton>
      <span aria-hidden />
      <ToolButton
        label="Atualizar o mapa"
        disabled={props.refreshing}
        onClick={props.onRefresh}
      >
        <RotateCw size={15} className={props.refreshing ? 'topology-refreshing' : undefined} />
      </ToolButton>
      {/* O rótulo diz o que o clique vai fazer; o estado fica no aria-pressed. */}
      <ToolButton
        label={props.allBranchesExpanded ? 'Fechar todos os ramos' : 'Abrir todos os ramos'}
        pressed={props.allBranchesExpanded}
        disabled={!props.hasBackbones}
        onClick={props.onToggleAllBranches}
      >
        {props.allBranchesExpanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
      </ToolButton>
      <ToolButton
        label={props.labelsVisible
          ? 'Ocultar as etiquetas das ligações'
          : 'Mostrar as etiquetas das ligações'}
        pressed={props.labelsVisible}
        onClick={props.onToggleLabels}
      >
        {props.labelsVisible ? <Eye size={15} /> : <EyeOff size={15} />}
      </ToolButton>
      <ToolButton
        label={props.legendVisible ? 'Ocultar a legenda' : 'Mostrar a legenda'}
        pressed={props.legendVisible}
        onClick={props.onToggleLegend}
      >
        <ListTree size={15} />
      </ToolButton>
      <ToolButton
        label={props.minimapVisible ? 'Ocultar o mini-mapa' : 'Mostrar o mini-mapa'}
        pressed={props.minimapVisible}
        onClick={props.onToggleMinimap}
      >
        <Map size={15} />
      </ToolButton>
      <ToolButton
        label={props.inspectorVisible ? 'Ocultar o inspetor' : 'Mostrar o inspetor'}
        pressed={props.inspectorVisible}
        onClick={props.onToggleInspector}
      >
        <PanelRight size={15} />
      </ToolButton>
      {/* "Horizontal/vertical" é ambíguo — TB desce mas espalha os irmãos ao
          longo da largura. O rótulo diz o desenho de destino. */}
      <ToolButton
        label={vertical
          ? 'Desenhar da esquerda para a direita'
          : 'Desenhar de cima para baixo'}
        onClick={props.onToggleDirection}
      >
        {vertical ? <MoveHorizontal size={15} /> : <MoveVertical size={15} />}
      </ToolButton>
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
      <ViewScope
        backbones={props.backbones}
        focusedBackboneId={props.focusedBackboneId}
        onFocusBackbone={props.onFocusBackbone}
      />
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
    </div>
  );
}
