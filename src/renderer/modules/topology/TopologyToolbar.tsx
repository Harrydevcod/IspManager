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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type {
  TopologyBackboneNode,
  TopologySearchResult
} from '../../../shared/topology';
import { Button, Field, Select } from '../../components';
import { CV_ISLANDS } from '../../lib/islands';
import { WAN_MODES, WAN_MODE_LABELS } from '../../../shared/wan';
import { OPERATION_MODES, OPERATION_MODE_LABELS } from '../../../shared/operation';
import { UNCLASSIFIED_OPERATION_MODE, UNCLASSIFIED_WAN_MODE } from './topology-filters';
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

export const SEARCH_LISTBOX_ID = 'topology-search-listbox';

/** Um id por opção: é o que o `aria-activedescendant` do campo aponta. */
function optionId(result: TopologySearchResult): string {
  return `topology-search-option-${result.node.id}`;
}

function resultKindLabel(node: TopologySearchResult['node']): string {
  if (node.kind === 'backbone') return 'Backbone físico';
  if (node.parentId === 'root:isp') return 'Equipamento do cliente · sem ligação definida';
  if (node.parentId.startsWith('assignment:')) {
    return 'Equipamento do cliente · atrás da antena dele';
  }
  return 'Antena do cliente';
}

/*
 * Combobox, não uma lista de botões.
 *
 * Antes: `role="listbox"` com `<Button role="option">` lá dentro (um botão não
 * é filho válido de uma listbox), `aria-selected` fixo em "false" — a lista
 * nunca dizia o que estava escolhido — e cada resultado era uma paragem de
 * tabulação. Nada ligava o campo à lista, nem havia setas ou Escape.
 *
 * Agora o foco fica no campo e move-se `aria-activedescendant`, que é o padrão
 * para isto. As mensagens de estado saíram de dentro da listbox: só opções
 * podem ser filhas dela.
 */
function SearchResults({
  query,
  state,
  results,
  activeIndex,
  onSelect
}: {
  query: string;
  state: SearchState;
  results: TopologySearchResult[];
  activeIndex: number;
  onSelect: (result: TopologySearchResult) => void;
}) {
  if (query.trim().length < 2) return null;
  return (
    <div className="topology-search-results">
      {state === 'loading' && <p role="status">A pesquisar na rede…</p>}
      {state === 'error' && <p role="alert">A pesquisa falhou. Tenta novamente.</p>}
      {state === 'idle' && results.length === 0 && <p>Sem resultados.</p>}
      <div id={SEARCH_LISTBOX_ID} role="listbox" aria-label="Resultados da topologia">
      {results.map((result, index) => (
        <div
          className="topology-search-result"
          role="option"
          id={optionId(result)}
          aria-selected={index === activeIndex}
          data-active={index === activeIndex || undefined}
          key={result.node.id}
          /* O `mousedown` só trava o blur — sem isso o campo perdia o foco e a
             lista fechava-se debaixo do ponteiro antes de o clique chegar. Quem
             seleciona continua a ser o `click`. */
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(result)}
        >
          <span>
            <strong>{result.node.label}</strong>
            <small>{resultKindLabel(result.node)}</small>
          </span>
          <em>{result.matchedFields.join(' · ')}</em>
        </div>
      ))}
      </div>
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

function WanModeFilter({ filters, onChange }: Omit<FiltersProps, 'onClear'>) {
  return (
    <Select
      label="Ligação"
      value={filters.wanMode ?? ''}
      onChange={(event) => onChange({ ...filters, wanMode: event.target.value || undefined })}
    >
      <option value="">Todas</option>
      {WAN_MODES.map((mode) => (
        <option key={mode} value={mode}>{WAN_MODE_LABELS[mode]}</option>
      ))}
      {/* A lista de trabalho de quem está a classificar o parque. */}
      <option value={UNCLASSIFIED_WAN_MODE}>Por classificar</option>
    </Select>
  );
}

function OperationModeFilter({ filters, onChange }: Omit<FiltersProps, 'onClear'>) {
  return (
    <Select
      label="Operação"
      value={filters.operationMode ?? ''}
      onChange={(event) => onChange({ ...filters, operationMode: event.target.value || undefined })}
    >
      <option value="">Todas</option>
      {OPERATION_MODES.map((mode) => (
        <option key={mode} value={mode}>{OPERATION_MODE_LABELS[mode]}</option>
      ))}
      <option value={UNCLASSIFIED_OPERATION_MODE}>Por classificar</option>
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
        <WanModeFilter filters={filters} onChange={onChange} />
        <OperationModeFilter filters={filters} onChange={onChange} />
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
function ToolButton({ label, pressed, disabled, loading, onClick, children }: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  /** Usa a prop do `Button`: traz `aria-busy` e o spinner, que faltavam aqui. */
  loading?: boolean;
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
      loading={loading}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/*
 * Roving tabindex, que é o que `role="toolbar"` promete.
 *
 * Os dez controlos do mapa eram dez paragens de tabulação: quem chegasse ao
 * mapa pelo teclado tinha de atravessar a barra inteira para lá chegar. O
 * padrão ARIA diz uma paragem para a barra toda e setas lá dentro.
 *
 * Os botões são lidos do DOM em vez de se enfiar uma ref em cada `ToolButton`:
 * são dez, num só contentor, e o efeito corre a cada render de propósito —
 * quais estão desativados muda com o estado do mapa.
 */
function useRovingToolbar() {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  const enabledButtons = useCallback(() => [
    ...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  ].filter((button) => !button.disabled), []);

  useEffect(() => {
    const items = enabledButtons();
    if (items.length === 0) return;
    const active = Math.min(index, items.length - 1);
    items.forEach((button, position) => {
      button.tabIndex = position === active ? 0 : -1;
    });
  });

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const items = enabledButtons();
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.findIndex((button) => button === document.activeElement);
    const step = event.key === 'ArrowRight' ? 1 : items.length - 1;
    const next = ((current < 0 ? 0 : current) + step) % items.length;
    setIndex(next);
    items[next].focus();
  }

  return { ref, onKeyDown };
}

export function CanvasTools(props: CanvasToolsProps) {
  const roving = useRovingToolbar();
  const vertical = props.direction === 'TB';
  return (
    <div
      className="topology-canvas-tools"
      role="toolbar"
      aria-label="Controlos do mapa"
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
    >
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
        loading={props.refreshing}
        onClick={props.onRefresh}
      >
        <RotateCw size={15} />
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
  const { query, results, onQueryChange, onResultSelect } = props;
  const [activeIndex, setActiveIndex] = useState(-1);
  const open = query.trim().length >= 2;

  // Cada pesquisa nova recomeça sem nada apontado: manter o índice deixava o
  // `aria-activedescendant` a apontar para uma opção que já não existe.
  useEffect(() => { setActiveIndex(-1); }, [query, results.length]);

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      onQueryChange('');
      return;
    }
    if (!open || results.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : results.length - 1;
      // Parte de -1: a primeira seta para baixo aponta a primeira opção.
      const from = activeIndex < 0 ? -1 : activeIndex;
      setActiveIndex((from + 1 + step) % results.length);
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      onResultSelect(results[activeIndex]);
    }
  }

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
            value={query}
            role="combobox"
            aria-expanded={open}
            aria-controls={SEARCH_LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 && results[activeIndex]
              ? optionId(results[activeIndex])
              : undefined}
            aria-label="Pesquisar na topologia"
            placeholder="Cliente, código, IP, MAC, serial…"
            onKeyDown={handleSearchKeyDown}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <SearchResults
          query={query}
          state={props.searchState}
          results={results}
          activeIndex={activeIndex}
          onSelect={onResultSelect}
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
