import '@xyflow/react/dist/style.css';
import './TopologyModule.css';
import './TopologyCanvas.css';
import './TopologyInspector.css';

import { AlertTriangle, Network, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  TopologyBackboneBranch,
  TopologyNode,
  TopologySnapshot
} from '../../../shared/topology';
import { Button } from '../../components';
import { TopologyCanvas, type TopologyCanvasHandle } from './TopologyCanvas';
import { TopologyInspector } from './TopologyInspector';
import type { TopologyCanvasNode } from './TopologyNodes';
import { TopologyToolbar } from './TopologyToolbar';
import type { TopologyApi } from './topology-api';
import { filterTopologyGraph } from './topology-filters';
import {
  composeTopologyGraph,
  topologyRelationshipLabel,
  type TopologyFlowEdge,
  type TopologyGraph
} from './topology-graph';
import { layoutTopologyGraph } from './topology-layout';
import { useTopologyWorkspace } from './useTopologyWorkspace';
import type { TopologyModuleProps } from './TopologyModule';

export type TopologyMapViewProps = TopologyModuleProps & {
  revision: number;
  active: boolean;
  focusBackboneDeviceId: number | null;
  onFocusHandled: () => void;
};

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
  labelsVisible: boolean
) {
  const graph = useMemo(() => {
    if (!snapshot) return { nodes: [], edges: [] };
    const composed = composeTopologyGraph(snapshot, workspace.branches, workspace.expanded);
    return layoutTopologyGraph(filterTopologyGraph(composed, workspace.filters));
  }, [snapshot, workspace.branches, workspace.expanded, workspace.filters]);
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
    workspace.setSelectedNode(backbone);
    workspace.setPendingFocusId(backbone.id);
  }, [focusBackboneDeviceId, onFocusHandled, workspace]);
}

function TopologyHeader({ snapshot }: { snapshot: TopologySnapshot }) {
  return (
    <header className="topology-header">
      <div>
        <p className="eyebrow">Infraestrutura · leitura</p>
        <h2 id="topology-title">Topologia de rede</h2>
        <p>Mapa físico · ligações definidas</p>
      </div>
      <dl className="topology-stats" aria-label="Resumo factual">
        <div><dt>Backbones</dt><dd>{snapshot.stats.backboneCount}</dd></div>
        <div><dt>CPE ligadas</dt><dd>{snapshot.stats.mappedAssignmentCount}</dd></div>
        <div data-tone={snapshot.stats.unmappedAssignmentCount > 0 ? 'attention' : undefined}>
          <dt>Sem ligação</dt><dd>{snapshot.stats.unmappedAssignmentCount}</dd>
        </div>
        <div><dt>Clientes</dt><dd>{snapshot.stats.clientCount}</dd></div>
        <div data-tone={snapshot.stats.attentionCount > 0 ? 'attention' : undefined}>
          <dt>Atenções</dt><dd>{snapshot.stats.attentionCount}</dd>
        </div>
      </dl>
    </header>
  );
}

function TopologyControls({
  workspace,
  labelsVisible,
  legendVisible,
  setLabelsVisible,
  setLegendVisible,
  canvasRef
}: {
  workspace: ReturnType<typeof useTopologyWorkspace>;
  labelsVisible: boolean;
  legendVisible: boolean;
  setLabelsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setLegendVisible: React.Dispatch<React.SetStateAction<boolean>>;
  canvasRef: React.RefObject<TopologyCanvasHandle | null>;
}) {
  return (
      <TopologyToolbar
        query={workspace.query}
        searchState={workspace.searchState}
        results={workspace.searchResults}
        filters={workspace.filters}
        labelsVisible={labelsVisible}
        legendVisible={legendVisible}
        onQueryChange={workspace.setQuery}
        onResultSelect={(result) => { void workspace.selectSearchResult(result); }}
        onFiltersChange={workspace.setFilters}
        onClearFilters={() => workspace.setFilters({})}
        onToggleLabels={() => setLabelsVisible((visible) => !visible)}
        onToggleLegend={() => setLegendVisible((visible) => !visible)}
        onZoomIn={() => canvasRef.current?.zoomIn()}
        onZoomOut={() => canvasRef.current?.zoomOut()}
        onFit={() => canvasRef.current?.fit()}
      />
  );
}

function TopologyStage({
  props,
  workspace,
  snapshot,
  nodes,
  edges,
  legendVisible,
  canvasRef
}: {
  props: TopologyModuleProps;
  workspace: ReturnType<typeof useTopologyWorkspace>;
  snapshot: TopologySnapshot;
  nodes: TopologyCanvasNode[];
  edges: TopologyFlowEdge[];
  legendVisible: boolean;
  canvasRef: React.RefObject<TopologyCanvasHandle | null>;
}) {
  const filteredEmpty = nodes.length === 0
    || (hasActiveFilters(workspace.filters) && nodes.length === 1);
  const inspectorBranch = branchForNode(workspace.selectedNode, workspace.branches);
  return (
      <div className="topology-workspace">
        <div className="topology-canvas-shell">
          <div className="topology-lanes" aria-hidden>
            <span>ORIGEM LÓGICA</span><span>BACKBONE</span><span>CPE / CLIENTE</span>
          </div>
          <TopologyCanvas
            ref={canvasRef}
            nodes={nodes}
            edges={edges}
            legendVisible={legendVisible}
          />
          {(snapshot.backbones.length === 0 || filteredEmpty) && (
            <EmptyCanvas filtered={hasActiveFilters(workspace.filters)} />
          )}
        </div>
        <TopologyInspector
          node={workspace.selectedNode}
          snapshot={snapshot}
          branch={inspectorBranch}
          onClose={() => workspace.setSelectedNode(null)}
          onOpenClient={props.onOpenClient}
          onOpenService={props.onOpenService}
          onOpenStock={props.onOpenStock}
        />
      </div>
  );
}

function TopologyMapWorkspace(
  props: Omit<TopologyMapViewProps, 'revision'>
) {
  const workspace = useTopologyWorkspace(props.api);
  const canvasRef = useRef<TopologyCanvasHandle>(null);
  const [labelsVisible, setLabelsVisible] = useState(false);
  const [legendVisible, setLegendVisible] = useState(true);
  const { nodes, edges } = useRenderedGraph(workspace.snapshot, workspace, labelsVisible);
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
  return (
    <section className="topology-module" aria-labelledby="topology-title">
      <TopologyHeader snapshot={workspace.snapshot} />
      <TopologyControls
        workspace={workspace}
        labelsVisible={labelsVisible}
        legendVisible={legendVisible}
        setLabelsVisible={setLabelsVisible}
        setLegendVisible={setLegendVisible}
        canvasRef={canvasRef}
      />
      <TopologyStage
        props={props}
        workspace={workspace}
        snapshot={workspace.snapshot}
        nodes={nodes}
        edges={edges}
        legendVisible={legendVisible}
        canvasRef={canvasRef}
      />
    </section>
  );
}

export default function TopologyMapView({
  revision,
  ...props
}: TopologyMapViewProps) {
  return <TopologyMapWorkspace key={revision} {...props} />;
}
