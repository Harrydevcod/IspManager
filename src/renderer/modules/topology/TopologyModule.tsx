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
  type TopologyFlowEdge,
  type TopologyGraph
} from './topology-graph';
import { layoutTopologyGraph } from './topology-layout';
import { useTopologyWorkspace } from './useTopologyWorkspace';

export type TopologyModuleProps = {
  api?: TopologyApi;
  onOpenClient: (clientId: number) => void;
  onOpenService: (clientId: number, serviceId: number) => void;
  onOpenStock: (catalogId: number) => void;
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
    const catalogId = topology.kind === 'backbone' ? topology.catalogId : null;
    const branch = catalogId === null ? undefined : state.branches.get(catalogId);
    return {
      ...node,
      selected: state.selectedNode?.id === node.id,
      data: {
        ...node.data,
        ui: {
          expanded: catalogId === null ? false : state.expanded.has(catalogId),
          loading: catalogId === null ? false : state.loadingBranches.has(catalogId),
          error: catalogId === null ? undefined : state.branchErrors.get(catalogId),
          branchCount: branch?.stats.assignmentCount,
          onSelect: () => state.setSelectedNode(topology),
          onToggle: catalogId === null ? undefined : () => state.toggleBranch(catalogId),
          onRetry: catalogId === null ? undefined : () => state.retryBranch(catalogId)
        }
      }
    };
  });
}

function decorateEdges(graph: TopologyGraph, labelsVisible: boolean): TopologyFlowEdge[] {
  return graph.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    label: labelsVisible ? 'inventário' : undefined,
    labelStyle: { fill: 'oklch(72% 0.02 145)', fontSize: 10, fontWeight: 650 },
    labelBgStyle: { fill: 'oklch(20% 0.012 145)', fillOpacity: 0.96 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 3,
    style: {
      stroke: edge.data?.topology.kind === 'core-link'
        ? 'oklch(58% 0.08 151)'
        : 'oklch(48% 0.035 145)',
      strokeWidth: edge.data?.topology.kind === 'core-link' ? 1.8 : 1.25
    }
  }));
}

function branchForNode(
  node: TopologyNode | null,
  branches: ReadonlyMap<number, TopologyBackboneBranch>
): TopologyBackboneBranch | undefined {
  if (!node || node.kind === 'logical-root') return undefined;
  if (node.kind === 'backbone') return branches.get(node.catalogId);
  const parent = Number(node.parentId.replace('backbone:', ''));
  return branches.get(parent);
}

function TopologyLoading() {
  return (
    <section className="topology-loading" aria-label="A carregar topologia">
      <span className="topology-loading-line" />
      <span className="topology-loading-line" />
      <p>A preparar o mapa de inventário…</p>
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
      <h3>{filtered ? 'Revê os filtros ativos' : 'Ainda não há backbones no inventário'}</h3>
      <p>
        {filtered
          ? 'Limpa um filtro ou expande outros ramos para comparar dados já carregados.'
          : 'Marca unidades backbone no Stock. O mapa irá agrupá-las aqui sem inferir conectividade.'}
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
  workspace: ReturnType<typeof useTopologyWorkspace>
) {
  useEffect(() => {
    if (!workspace.pendingFocusId) return;
    if (!nodes.some((node) => node.id === workspace.pendingFocusId)) return;
    const frame = window.requestAnimationFrame(() => {
      canvasRef.current?.centerNode(workspace.pendingFocusId!);
      workspace.setPendingFocusId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasRef, nodes, workspace]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') workspace.setSelectedNode(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [workspace]);
}

function TopologyHeader({ snapshot }: { snapshot: TopologySnapshot }) {
  return (
    <header className="topology-header">
      <div>
        <p className="eyebrow">Infraestrutura · leitura</p>
        <h2 id="topology-title">Topologia de rede</h2>
        <p>Mapa de inventário</p>
      </div>
      <dl className="topology-stats" aria-label="Resumo factual">
        <div><dt>Backbones</dt><dd>{snapshot.stats.backboneCount}</dd></div>
        <div><dt>CPE mapeadas</dt><dd>{snapshot.stats.mappedAssignmentCount}</dd></div>
        <div data-tone={snapshot.stats.unmappedAssignmentCount > 0 ? 'attention' : undefined}>
          <dt>Sem linhagem</dt><dd>{snapshot.stats.unmappedAssignmentCount}</dd>
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

export default function TopologyModule(props: TopologyModuleProps) {
  const workspace = useTopologyWorkspace(props.api);
  const canvasRef = useRef<TopologyCanvasHandle>(null);
  const [labelsVisible, setLabelsVisible] = useState(false);
  const [legendVisible, setLegendVisible] = useState(true);
  const { nodes, edges } = useRenderedGraph(workspace.snapshot, workspace, labelsVisible);
  useCanvasEffects(canvasRef, nodes, workspace);
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
