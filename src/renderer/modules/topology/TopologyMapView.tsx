import '@xyflow/react/dist/style.css';
import './TopologyModule.css';
import './TopologyCanvas.css';
import './TopologyInspector.css';

import { AlertTriangle, Network, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  TopologyBackboneBranch,
  TopologyNode,
  TopologySnapshot
} from '../../../shared/topology';
import { Button } from '../../components';
import { BackboneEditorDialog } from './BackboneDialogs';
import { TopologyCanvas, type TopologyCanvasHandle } from './TopologyCanvas';
import { TopologyInspector } from './TopologyInspector';
import type { TopologyCanvasNode } from './TopologyNodes';
import { CanvasTools, TopologyToolbar, type CanvasToolsProps } from './TopologyToolbar';
import type { TopologyApi } from './topology-api';
import { filterTopologyGraph } from './topology-filters';
import {
  composeTopologyGraph,
  scopeGraphToBackbone,
  topologyRelationshipLabel,
  type TopologyFlowEdge,
  type TopologyGraph
} from './topology-graph';
import { layoutTopologyGraph, type TopologyDirection } from './topology-layout';
import { useMapAuthoring } from './useMapAuthoring';
import { useTopologyWorkspace } from './useTopologyWorkspace';
import type { TopologyModuleProps } from './TopologyModule';

export type TopologyMapViewProps = TopologyModuleProps & {
  revision: number;
  active: boolean;
  focusBackboneDeviceId: number | null;
  onFocusHandled: () => void;
  onMutation: () => void;
  /** Onde os controlos do mapa são desenhados: a tira das abas, fora do canvas. */
  toolsSlot: HTMLElement | null;
};

type MapAuthoring = ReturnType<typeof useMapAuthoring>;

type NodeDecorators = Pick<
  ReturnType<typeof useTopologyWorkspace>,
  | 'branches'
  | 'expanded'
  | 'loadingBranches'
  | 'branchErrors'
  | 'selectedNode'
  | 'toggleBranch'
  | 'retryBranch'
  | 'setSelectedNode'
>;

function decorateNodes(graph: TopologyGraph, state: NodeDecorators): TopologyCanvasNode[] {
  return graph.nodes.map((node) => {
    const topology = node.data.topology;
    const backboneDeviceId = topology.kind === 'backbone'
      ? topology.backboneDeviceId
      : null;
    const branch = backboneDeviceId === null
      ? undefined
      : state.branches.get(backboneDeviceId);
    return {
      ...node,
      selected: state.selectedNode?.id === node.id,
      data: {
        ...node.data,
        ui: {
          expanded: backboneDeviceId === null
            ? false
            : state.expanded.has(backboneDeviceId),
          loading: backboneDeviceId === null
            ? false
            : state.loadingBranches.has(backboneDeviceId),
          error: backboneDeviceId === null
            ? undefined
            : state.branchErrors.get(backboneDeviceId),
          branchCount: branch?.stats.assignmentCount,
          onSelect: () => state.setSelectedNode(topology),
          onToggle: backboneDeviceId === null
            ? undefined
            : () => state.toggleBranch(backboneDeviceId),
          onRetry: backboneDeviceId === null
            ? undefined
            : () => state.retryBranch(backboneDeviceId)
        }
      }
    };
  });
}

function decorateEdges(graph: TopologyGraph, labelsVisible: boolean): TopologyFlowEdge[] {
  return graph.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    label: labelsVisible && edge.data
      ? topologyRelationshipLabel(edge.data.topology.relationship)
      : undefined,
    labelStyle: { fill: 'var(--text-2)', fontSize: 11, fontWeight: 650 },
    labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.96 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 3,
    style: {
      stroke: edge.data?.topology.kind === 'core-link'
        ? 'var(--accent-2)'
        : 'var(--border-2)',
      strokeWidth: edge.data?.topology.kind === 'core-link' ? 1.8 : 1.25
    }
  }));
}

function branchForNode(
  node: TopologyNode | null,
  branches: ReadonlyMap<number, TopologyBackboneBranch>
): TopologyBackboneBranch | undefined {
  if (!node || node.kind === 'logical-root') return undefined;
  if (node.kind === 'backbone') return branches.get(node.backboneDeviceId);
  const parent = Number(node.parentId.replace('backbone:', ''));
  return branches.get(parent);
}

function TopologyLoading() {
  return (
    <section className="topology-loading" aria-label="A carregar topologia">
      <span className="topology-loading-line" />
      <span className="topology-loading-line" />
      <p>A preparar o mapa físico…</p>
    </section>
  );
}

function TopologyGlobalError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="topology-global-error" role="alert">
      <AlertTriangle size={20} aria-hidden />
      <div>
        <h3>Não foi possível abrir a topologia</h3>
        <p>Confirma a ligação à API local e tenta novamente.</p>
      </div>
      <Button
        variant="secondary"
        leadingIcon={<RotateCw size={14} aria-hidden />}
        onClick={onRetry}
      >
        Tentar novamente
      </Button>
    </section>
  );
}

function EmptyCanvas({ filtered }: { filtered: boolean }) {
  return (
    <div className="topology-canvas-empty">
      <Network size={22} aria-hidden />
      <p className="eyebrow">{filtered ? 'Sem correspondências' : 'Primeiro mapa'}</p>
      <h3>{filtered ? 'Revê os filtros ativos' : 'Ainda não há equipamentos backbone'}</h3>
      <p>
        {filtered
          ? 'Limpa um filtro ou expande outros ramos para comparar dados já carregados.'
          : 'Quando forem registadas, as unidades físicas backbone serão apresentadas aqui.'}
      </p>
    </div>
  );
}

function hasActiveFilters(filters: ReturnType<typeof useTopologyWorkspace>['filters']): boolean {
  return Object.values(filters).some((value) => value !== undefined && value !== '');
}

function useRenderedGraph(
  snapshot: TopologySnapshot | null,
  workspace: ReturnType<typeof useTopologyWorkspace>,
  labelsVisible: boolean,
  direction: TopologyDirection
) {
  const focusedBackboneId = workspace.focusedBackboneId;
  const graph = useMemo(() => {
    if (!snapshot) return { nodes: [], edges: [] };
    const composed = composeTopologyGraph(snapshot, workspace.branches, workspace.expanded);
    // Recortar antes de filtrar: a vista escolhe a antena, os filtros escolhem
    // o que dentro dela interessa.
    const scoped = focusedBackboneId === null
      ? composed
      : scopeGraphToBackbone(composed, `backbone:${focusedBackboneId}`);
    return layoutTopologyGraph(
      filterTopologyGraph(scoped, workspace.filters),
      direction
    );
  }, [
    direction,
    focusedBackboneId,
    snapshot,
    workspace.branches,
    workspace.expanded,
    workspace.filters
  ]);
  const nodes = useMemo(
    () => decorateNodes(graph, workspace),
    [graph, workspace]
  );
  const edges = useMemo(
    () => decorateEdges(graph, labelsVisible),
    [graph, labelsVisible]
  );
  return { nodes, edges };
}

function useCanvasEffects(
  canvasRef: React.RefObject<TopologyCanvasHandle | null>,
  nodes: TopologyCanvasNode[],
  workspace: ReturnType<typeof useTopologyWorkspace>,
  active: boolean,
  focusBackboneDeviceId: number | null,
  onFocusHandled: () => void
) {
  const { pendingFocusId, setPendingFocusId, setSelectedNode } = workspace;
  // ponytail: only the primitives may enter the deps — `workspace` and `nodes`
  // change identity on every render, which cancelled the frame before it ran.
  const focusable = pendingFocusId !== null
    && nodes.some((node) => node.id === pendingFocusId);

  useEffect(() => {
    if (!pendingFocusId || !focusable) return;
    const frame = window.requestAnimationFrame(() => {
      canvasRef.current?.centerNode(pendingFocusId);
      if (pendingFocusId === `backbone:${focusBackboneDeviceId}`) {
        onFocusHandled();
      }
      setPendingFocusId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    canvasRef,
    focusable,
    focusBackboneDeviceId,
    onFocusHandled,
    pendingFocusId,
    setPendingFocusId
  ]);

  useEffect(() => {
    if (!active) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedNode(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [active, setSelectedNode]);
}

/**
 * O mapa não pode mostrar uma fotografia velha da rede. Recarrega-se quando a
 * outra aba avisa que mexeu em alguma coisa (`revision`) e quando volta a ficar
 * visível — instalar um serviço com equipamento noutro módulo liga a CPE a um
 * backbone, e essa CPE tem de estar lá quando o operador volta ao mapa.
 *
 * Recarregar em vez de remontar: os ramos abertos ficam abertos.
 */
function useMapFreshness(refresh: () => Promise<void>, revision: number, active: boolean) {
  const seenRef = useRef({ revision, active });
  useEffect(() => {
    const seen = seenRef.current;
    const becameActive = active && !seen.active;
    const changed = revision !== seen.revision;
    seenRef.current = { revision, active };
    // A primeira leitura já vem do arranque do workspace, e uma alteração feita
    // com o mapa escondido espera pelo regresso em vez de pedir duas vezes.
    if (becameActive || (changed && active)) void refresh();
  }, [active, refresh, revision]);
}

/**
 * Mudar a forma do grafo — virar a orientação, abrir ou fechar ramos, filtrar —
 * reposiciona tudo, e sem reenquadrar o desenho salta para fora da vista. Virar
 * não muda o número de nós, por isso o enquadramento do canvas (que segue as
 * medidas) não chega: é este que apanha a rotação.
 *
 * Sem `requestAnimationFrame` de propósito — ver a nota em TopologyCanvas: com
 * a janela em segundo plano o frame nunca corre e o enquadramento perdia-se.
 */
function useRefitOnShapeChange(
  canvasRef: React.RefObject<TopologyCanvasHandle | null>,
  direction: TopologyDirection,
  nodeCount: number
) {
  const previous = useRef(`${direction}:${nodeCount}`);
  useEffect(() => {
    const shape = `${direction}:${nodeCount}`;
    if (previous.current === shape) return;
    previous.current = shape;
    canvasRef.current?.fit();
  }, [canvasRef, direction, nodeCount]);
}

function useRequestedBackboneFocus(
  workspace: ReturnType<typeof useTopologyWorkspace>,
  focusBackboneDeviceId: number | null,
  onFocusHandled: () => void
) {
  const appliedFocusRef = useRef<number | null>(null);

  useEffect(() => {
    if (focusBackboneDeviceId === null) {
      appliedFocusRef.current = null;
      return;
    }
    if (!workspace.snapshot || appliedFocusRef.current === focusBackboneDeviceId) return;

    const backbone = workspace.snapshot.backbones.find(
      (candidate) => candidate.backboneDeviceId === focusBackboneDeviceId
    );
    if (!backbone) {
      onFocusHandled();
      return;
    }

    appliedFocusRef.current = focusBackboneDeviceId;
    // Quem vem da lista de backbones quer ver aquele equipamento, não a rede
    // toda: o mapa abre já recortado nele.
    workspace.focusBackbone(focusBackboneDeviceId);
    workspace.setSelectedNode(backbone);
    workspace.setPendingFocusId(backbone.id);
  }, [focusBackboneDeviceId, onFocusHandled, workspace]);
}

/**
 * Uma tira, uma linha. O título saiu: a aba já diz "Topologia" e o mapa é o
 * conteúdo — cada pixel de cromo aqui é um pixel a menos de rede à vista.
 */
function TopologyStatsBar({
  snapshot,
  focused,
  onClearFocus
}: {
  snapshot: TopologySnapshot;
  focused: TopologySnapshot['backbones'][number] | null;
  onClearFocus: () => void;
}) {
  return (
    <header className="topology-header">
      {/* Os números são da rede toda. Com a vista recortada, o chip diz para
          onde se está a olhar — senão lêem-se como se fossem do que está no
          ecrã. */}
      {focused && (
        // Exceção deliberada à regra do <Button>: isto é um chip de estado que
        // se dispensa, não um comando — a barra de ferramentas do mapa usa
        // <Button> para os comandos. O sistema não tem primitiva de chip e
        // criar uma para um só sítio seria abstrair cedo demais; se aparecer um
        // segundo chip clicável, promove-se então.
        // eslint-disable-next-line no-restricted-syntax
        <button
          type="button"
          className="topology-scope-chip"
          onClick={onClearFocus}
        >
          <span>Vista: {focused.label}</span>
          <X size={12} aria-hidden />
          <span className="sr-only">Voltar à rede completa</span>
        </button>
      )}
      <dl className="topology-stats" aria-label="Resumo factual">
        <div><dt>Backbones</dt><dd>{snapshot.stats.backboneCount}</dd></div>
        <div><dt>CPE ligadas</dt><dd>{snapshot.stats.mappedAssignmentCount}</dd></div>
        <div data-tone={snapshot.stats.unmappedAssignmentCount > 0 ? 'attention' : undefined}>
          <dt>Sem ligação</dt><dd>{snapshot.stats.unmappedAssignmentCount}</dd>
        </div>
        {/* Os dois motivos para um cliente não estar no mapa: falta a CPE, ou
            falta dizer de que backbone ela pende. */}
        <div data-tone={snapshot.stats.servicesWithoutDeviceCount > 0 ? 'attention' : undefined}>
          <dt>Sem equipamento</dt><dd>{snapshot.stats.servicesWithoutDeviceCount}</dd>
        </div>
        <div><dt>Clientes</dt><dd>{snapshot.stats.clientCount}</dd></div>
        <div data-tone={snapshot.stats.attentionCount > 0 ? 'attention' : undefined}>
          <dt>Atenções</dt><dd>{snapshot.stats.attentionCount}</dd>
        </div>
      </dl>
    </header>
  );
}


function TopologyStage({
  props,
  workspace,
  snapshot,
  nodes,
  edges,
  legendVisible,
  inspectorVisible,
  tools,
  toolsSlot,
  onCloseInspector,
  authoring,
  canvasRef
}: {
  props: TopologyModuleProps;
  workspace: ReturnType<typeof useTopologyWorkspace>;
  snapshot: TopologySnapshot;
  nodes: TopologyCanvasNode[];
  edges: TopologyFlowEdge[];
  legendVisible: boolean;
  inspectorVisible: boolean;
  tools: CanvasToolsProps;
  toolsSlot: HTMLElement | null;
  onCloseInspector: () => void;
  authoring: MapAuthoring;
  canvasRef: React.RefObject<TopologyCanvasHandle | null>;
}) {
  const filteredEmpty = nodes.length === 0
    || (hasActiveFilters(workspace.filters) && nodes.length === 1);
  const inspectorBranch = branchForNode(workspace.selectedNode, workspace.branches);
  return (
      <div
        className="topology-workspace"
        data-inspector={inspectorVisible ? undefined : 'collapsed'}
      >
        <div className="topology-canvas-shell">
          {/* ponytail: sem faixas fixas — a cadeia física tem profundidade variável
              (Starlink → router → switch → AP → CPE) e os rótulos passariam a
              nomear a coluna errada. O dagre distribui os ranks sozinho. */}
          <TopologyCanvas
            ref={canvasRef}
            nodes={nodes}
            edges={edges}
            legendVisible={legendVisible}
            connectable={authoring.canManage}
            onConnectNodes={authoring.connectNodes}
          />
          {/* Os controlos saem daqui por portal para a tira das abas: em cima do
              canvas tapavam a raiz do grafo, que é onde o dagre começa a desenhar.
              O estado deles continua neste componente — o portal move o DOM. */}
          {toolsSlot && createPortal(<CanvasTools {...tools} />, toolsSlot)}
          {(snapshot.backbones.length === 0 || filteredEmpty) && (
            <EmptyCanvas filtered={hasActiveFilters(workspace.filters)} />
          )}
        </div>
        {inspectorVisible && (
          <TopologyInspector
            node={workspace.selectedNode}
            snapshot={snapshot}
            branch={inspectorBranch}
            onClose={onCloseInspector}
            onOpenClient={props.onOpenClient}
            onOpenService={props.onOpenService}
            onOpenStock={props.onOpenStock}
            onDisconnectUpstream={authoring.canManage ? authoring.disconnectUpstream : undefined}
            focusedBackboneId={workspace.focusedBackboneId}
            onFocusBackbone={workspace.focusBackbone}
          />
        )}
      </div>
  );
}

function TopologyMapWorkspace(props: TopologyMapViewProps) {
  const workspace = useTopologyWorkspace(props.api);
  // Registar ou ligar recarrega o mapa no sítio — remontar fecharia os ramos
  // abertos — e avisa o módulo para refrescar a lista da aba Backbone.
  const { onMutation } = props;
  const { refresh } = workspace;
  const authoring = useMapAuthoring(useCallback(() => {
    void refresh();
    onMutation();
  }, [refresh, onMutation]));
  useMapFreshness(refresh, props.revision, props.active);
  const canvasRef = useRef<TopologyCanvasHandle>(null);
  const [labelsVisible, setLabelsVisible] = useState(false);
  const [legendVisible, setLegendVisible] = useState(true);
  // O mapa abre inteiro: o inspetor só aparece quando houver nó selecionado.
  const [inspectorVisible, setInspectorVisible] = useState(false);
  const [direction, setDirection] = useState<TopologyDirection>('TB');
  const { nodes, edges } = useRenderedGraph(
    workspace.snapshot,
    workspace,
    labelsVisible,
    direction
  );
  useRefitOnShapeChange(canvasRef, direction, nodes.length);
  // Escolher um nó com o painel recolhido volta a abri-lo — senão o clique
  // parecia não fazer nada. Recolher com o mesmo nó selecionado não mexe no id,
  // por isso o painel fica fechado como foi pedido.
  const selectedNodeId = workspace.selectedNode?.id;
  useEffect(() => {
    if (selectedNodeId) setInspectorVisible(true);
  }, [selectedNodeId]);
  useRequestedBackboneFocus(
    workspace,
    props.focusBackboneDeviceId,
    props.onFocusHandled
  );
  useCanvasEffects(
    canvasRef,
    nodes,
    workspace,
    props.active,
    props.focusBackboneDeviceId,
    props.onFocusHandled
  );
  if (!workspace.snapshot && !workspace.globalError) return <TopologyLoading />;
  if (!workspace.snapshot) {
    return <TopologyGlobalError onRetry={() => { void workspace.loadSnapshot(true); }} />;
  }
  const tools: CanvasToolsProps = {
    labelsVisible,
    legendVisible,
    inspectorVisible,
    allBranchesExpanded: workspace.allBranchesExpanded,
    hasBackbones: workspace.snapshot.backbones.length > 0,
    direction,
    refreshing: workspace.refreshing,
    onRefresh: () => { void workspace.refresh(); },
    onToggleLabels: () => setLabelsVisible((visible) => !visible),
    onToggleLegend: () => setLegendVisible((visible) => !visible),
    onToggleInspector: () => setInspectorVisible((visible) => !visible),
    onToggleDirection: () => setDirection((current) => current === 'LR' ? 'TB' : 'LR'),
    onToggleAllBranches: workspace.toggleAllBranches,
    onZoomIn: () => canvasRef.current?.zoomIn(),
    onZoomOut: () => canvasRef.current?.zoomOut(),
    onFit: () => canvasRef.current?.fit()
  };
  return (
    <section className="topology-module" aria-label="Topologia de rede">
      <TopologyStatsBar
        snapshot={workspace.snapshot}
        focused={workspace.snapshot.backbones.find(
          (backbone) => backbone.backboneDeviceId === workspace.focusedBackboneId
        ) ?? null}
        onClearFocus={() => workspace.focusBackbone(null)}
      />
      <TopologyToolbar
        query={workspace.query}
        searchState={workspace.searchState}
        results={workspace.searchResults}
        filters={workspace.filters}
        backbones={workspace.snapshot.backbones}
        focusedBackboneId={workspace.focusedBackboneId}
        onFocusBackbone={workspace.focusBackbone}
        canManage={authoring.canManage}
        onCreateDevice={authoring.openEditor}
        onQueryChange={workspace.setQuery}
        onResultSelect={(result) => { void workspace.selectSearchResult(result); }}
        onFiltersChange={workspace.setFilters}
        onClearFilters={() => workspace.setFilters({})}
      />
      <TopologyStage
        props={props}
        workspace={workspace}
        snapshot={workspace.snapshot}
        nodes={nodes}
        edges={edges}
        legendVisible={legendVisible}
        inspectorVisible={inspectorVisible}
        tools={tools}
        toolsSlot={props.toolsSlot}
        onCloseInspector={() => {
          setInspectorVisible(false);
          workspace.setSelectedNode(null);
        }}
        authoring={authoring}
        canvasRef={canvasRef}
      />
      {authoring.canManage && (
        <BackboneEditorDialog
          open={authoring.editorOpen}
          backbone={null}
          pending={authoring.pending}
          error={authoring.error}
          catalogs={authoring.catalogs}
          catalogLoading={authoring.catalogLoading}
          catalogError={authoring.catalogError}
          upstreamOptions={authoring.upstreamOptions}
          onCatalogRetry={authoring.retryCatalogs}
          onClose={authoring.closeEditor}
          onSubmit={authoring.createDevice}
        />
      )}
    </section>
  );
}

export default function TopologyMapView(props: TopologyMapViewProps) {
  return <TopologyMapWorkspace {...props} />;
}
