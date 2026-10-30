import {
  Background,
  type NodeChange,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow
} from '@xyflow/react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from 'react';
import type { DragEvent, ForwardedRef, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { isValidBackboneConnection, parseBackboneNodeId } from './backbone-linking';
import { CATALOG_DRAG_TYPE } from './EquipmentPalette';
import { keyboardLinks, type TopologyFlowEdge } from './topology-graph';
import {
  topologyNodeTypes,
  type TopologyCanvasNode
} from './TopologyNodes';

export type TopologyCanvasHandle = {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  centerNode: (nodeId: string) => void;
};

type TopologyCanvasProps = {
  nodes: TopologyCanvasNode[];
  edges: TopologyFlowEdge[];
  legendVisible: boolean;
  minimapVisible: boolean;
  /** Permite arrastar uma ligação entre unidades de backbone. */
  connectable?: boolean;
  onConnectNodes?: (sourceNodeId: string, targetNodeId: string) => void;
  /** Duplo clique no fundo — abre a paleta, como "pesquisa rápida". */
  onPaneDoubleClick?: () => void;
  /** Um cartão da paleta largado no mapa; em cima de uma backbone, ela é o montante. */
  onDropCatalog?: (catalogId: number, upstreamDeviceId: number | null) => void;
  /** Mover nós à mão (e em grupo, com Shift + caixa). Sem isto o mapa é só leitura. */
  draggable?: boolean;
  onNodesChange?: (changes: NodeChange<TopologyCanvasNode>[]) => void;
  onNodeDragStart?: (nodes: TopologyCanvasNode[]) => void;
  onNodeDragStop?: (nodes: TopologyCanvasNode[]) => void;
  /** Clicar numa ligação — abre as propriedades dela. */
  onEdgeClick?: (edgeId: string) => void;
  /** Botão direito num nó ou numa ligação, com o ponto do ecrã onde abrir o menu. */
  onContextMenu?: (target: { nodeId: string } | { edgeId: string }, point: { x: number; y: number }) => void;
};

function acceptsCatalog(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(CATALOG_DRAG_TYPE);
}

/**
 * Espelho de `--motion-slow` (280ms) em JS.
 *
 * O React Flow anima a vista por número, não por CSS, por isso o token não lhe
 * chega. Era 260 — um valor órfão que não correspondia a degrau nenhum da
 * escala. Ler o token com `getComputedStyle` a cada zoom custava um reflow por
 * clique para poupar uma constante; fica o espelho, anotado, como os outros do
 * projeto.
 */
const MOTION_SLOW_MS = 280;

function motionDuration(): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 0
    : MOTION_SLOW_MS;
}

function miniMapColor(node: TopologyCanvasNode): string {
  if (node.data.topology.issueCodes.length > 0) return 'var(--warn)';
  if (node.type === 'logical-root') return 'var(--accent)';
  if (node.type === 'backbone') return 'var(--accent-2)';
  return 'var(--text-3)';
}

type MenuTarget = { nodeId: string } | { edgeId: string };

/** O nó ou a ligação onde está o foco (ou o clique), com o id que o React Flow lhe deu. */
function flowTarget(element: Element): { element: Element; target: MenuTarget } | null {
  const node = element.closest('.react-flow__node');
  const nodeId = node?.getAttribute('data-id');
  if (node && nodeId) return { element: node, target: { nodeId } };
  const edge = element.closest('.react-flow__edge');
  const edgeId = edge?.getAttribute('data-id');
  if (edge && edgeId) return { element: edge, target: { edgeId } };
  return null;
}

/** Sem rato não há ponto de clique: o menu abre colado ao canto de baixo do elemento. */
function anchorBelow(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom + 4 };
}

/**
 * A legenda e o mini-mapa pousam no fundo do mapa: enquadrar sem contar com eles deixava
 * a última fila de equipamentos por baixo da legenda (4 nós a 1225 px). O fundo reserva a
 * altura do que lá estiver; sem nada medido (escondidos, jsdom) fica a margem de sempre.
 */
export function fitPadding(section: HTMLElement | null, base: number) {
  const bottom = section?.getBoundingClientRect().bottom ?? 0;
  const covered = Math.max(0, ...[...(section?.querySelectorAll('.topology-legend, .topology-minimap') ?? [])]
    .map((element) => bottom - element.getBoundingClientRect().top));
  return covered > 0 ? { x: base, top: base, bottom: `${Math.round(covered + 12)}px` as const } : base;
}

function useCanvasControls(
  ref: ForwardedRef<TopologyCanvasHandle>,
  nodes: TopologyCanvasNode[],
  sectionRef: RefObject<HTMLElement | null>
) {
  const flow = useReactFlow<TopologyCanvasNode, TopologyFlowEdge>();
  const nodesInitialized = useNodesInitialized();
  const fittedCount = useRef(0);
  useImperativeHandle(ref, () => ({
    fit: () => void flow.fitView({ padding: fitPadding(sectionRef.current, 0.18), duration: motionDuration() }),
    zoomIn: () => void flow.zoomIn({ duration: motionDuration() }),
    zoomOut: () => void flow.zoomOut({ duration: motionDuration() }),
    centerNode: (nodeId) => {
      const node = flow.getNode(nodeId);
      if (!node) return;
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      void flow.setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        { zoom: Math.max(flow.getZoom(), 0.9), duration: motionDuration() }
      );
    }
  }), [flow]);
  /**
   * Enquadrar sem `requestAnimationFrame`: o frame só corre com a janela à
   * vista, por isso um mapa montado com a janela minimizada ou em segundo plano
   * abria por enquadrar — e, em `StrictMode`, a cleanup da primeira passagem
   * cancelava o frame que a segunda já não voltava a agendar.
   *
   * `useNodesInitialized` diz que o React Flow já mediu os nós, que é a única
   * condição de que o enquadramento precisa: sem medidas, `fitView` só conta os
   * nós medidos e a escala sai calculada sobre um subconjunto do grafo.
   */
  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0) return;
    if (fittedCount.current === nodes.length) return;
    fittedCount.current = nodes.length;
    // Sem animação: o mapa acabou de aparecer, não há de onde animar — e a
    // transição do `setViewport` corre em `requestAnimationFrame`, que não corre
    // com a janela em segundo plano. Assim o enquadramento aplica-se sempre.
    void flow.fitView({ padding: fitPadding(sectionRef.current, 0.2), duration: 0 });
  }, [flow, nodes.length, nodesInitialized, sectionRef]);
}

const TopologyCanvasInner = forwardRef<TopologyCanvasHandle, TopologyCanvasProps>(
  function TopologyCanvasInner({
    nodes,
    edges,
    legendVisible,
    minimapVisible,
    connectable = false,
    onConnectNodes,
    onPaneDoubleClick,
    onDropCatalog,
    draggable = false,
    onNodesChange,
    onNodeDragStart,
    onNodeDragStop,
    onEdgeClick,
    onContextMenu
  }, ref) {
    const sectionRef = useRef<HTMLElement>(null);
    useCanvasControls(ref, nodes, sectionRef);

    // As ligações editáveis entram no Tab com o nome das pontas. A chave junta só ids e nomes:
    // arrastar um nó muda as posições a cada frame e não pode voltar a criar as ligações.
    const labelKey = nodes.map((node) => `${node.id}\u0000${node.data.topology.label}`).join('\u0001');
    const flowEdges = useMemo(() => {
      if (!onEdgeClick) return edges;
      const labels = new Map(labelKey.split('\u0001').map((pair) => pair.split('\u0000') as [string, string]));
      return keyboardLinks(edges, (nodeId) => labels.get(nodeId) ?? nodeId);
    }, [edges, labelKey, onEdgeClick]);

    // O teclado faz o que o rato faz: Shift+F10 ou a tecla Menu abrem o menu do nó ou da
    // ligação com foco, e Enter (ou espaço) numa ligação abre a ficha dela.
    const onCanvasKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      const found = flowTarget(event.target as Element);
      if (!found) return;
      const menuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
      if (menuKey && onContextMenu) {
        event.preventDefault();
        onContextMenu(found.target, anchorBelow(found.element));
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && 'edgeId' in found.target && onEdgeClick) {
        event.preventDefault();
        onEdgeClick(found.target.edgeId);
      }
    };
    // Um `contextmenu` vindo do teclado chega sem ponto (0, 0): abre colado ao elemento.
    const menuPoint = (event: MouseEvent) => (event.clientX === 0 && event.clientY === 0
      ? anchorBelow(event.target as Element)
      : { x: event.clientX, y: event.clientY });

    // <section> e não <div>: um `aria-label` num elemento sem role é descartado
    // pela maioria das tecnologias de apoio, e o mapa ficava sem nome nenhum.
    // A secção com nome é uma região, que se anuncia e se navega.
    return (
      <section
        ref={sectionRef}
        className="topology-canvas"
        aria-label="Mapa físico da rede"
        onKeyDown={onCanvasKeyDown}
        onDoubleClick={onPaneDoubleClick && ((event: MouseEvent<HTMLElement>) => {
          if ((event.target as Element).closest('.react-flow__pane')) onPaneDoubleClick();
        })}
        onDragOver={onDropCatalog && ((event) => {
          if (!acceptsCatalog(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        })}
        onDrop={onDropCatalog && ((event) => {
          if (!acceptsCatalog(event)) return;
          event.preventDefault();
          const catalogId = Number(event.dataTransfer.getData(CATALOG_DRAG_TYPE));
          if (!Number.isInteger(catalogId) || catalogId <= 0) return;
          const nodeId = (event.target as Element).closest('.react-flow__node')?.getAttribute('data-id') ?? '';
          onDropCatalog(catalogId, parseBackboneNodeId(nodeId));
        })}
      >
        {/* Sem `panOnScroll`: com ele o React Flow desloca a vista com a roda e
            manda o zoom para trás de Ctrl. Aqui a roda aproxima e o arrasto
            desloca, como em qualquer mapa. */}
        <ReactFlow<TopologyCanvasNode, TopologyFlowEdge>
          nodes={nodes}
          edges={flowEdges}
          nodeTypes={topologyNodeTypes}
          nodesDraggable={draggable}
          // Um clique com tremido de 1–3 px (trackpad, rato velho) não pode
          // arrumar o nó à mão e gravar uma posição: só conta a partir de 4 px.
          nodeDragThreshold={4}
          onNodesChange={onNodesChange}
          onNodeDragStart={(_event, _node, dragged) => onNodeDragStart?.(dragged)}
          onNodeDragStop={(_event, _node, dragged) => onNodeDragStop?.(dragged)}
          onEdgeClick={onEdgeClick && ((_event, edge) => onEdgeClick(edge.id))}
          onNodeContextMenu={onContextMenu && ((event, node) => {
            event.preventDefault();
            onContextMenu({ nodeId: node.id }, menuPoint(event));
          })}
          onEdgeContextMenu={onContextMenu && ((event, edge) => {
            event.preventDefault();
            onContextMenu({ edgeId: edge.id }, menuPoint(event));
          })}
          nodesConnectable={connectable}
          isValidConnection={(connection) => isValidBackboneConnection(
            connection.source,
            connection.target
          )}
          onConnect={(connection) => {
            if (!connection.source || !connection.target) return;
            onConnectNodes?.(connection.source, connection.target);
          }}
          nodesFocusable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          selectionKeyCode={draggable ? 'Shift' : null}
          multiSelectionKeyCode={draggable ? 'Shift' : null}
          minZoom={0.25}
          maxZoom={2.5}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={!onPaneDoubleClick}
          fitView={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color="var(--border-2)"
          />
          {/* O tamanho vive aqui, não no CSS: o React Flow lê `style.width/height`
              para calcular a escala do desenho e o mapeamento do arrasto. Uma
              caixa encolhida só por CSS deixava o SVG nos 200×150 por omissão —
              com todos os ramos abertos o grafo transbordava para fora dela. */}
          {minimapVisible && (
            <MiniMap
              className="topology-minimap"
              style={{ width: 180, height: 120 }}
              pannable
              zoomable
              nodeColor={miniMapColor}
              maskColor="color-mix(in oklch, var(--bg) 72%, transparent)"
            />
          )}
        </ReactFlow>
        {legendVisible && (
          <div className="topology-legend" role="group" aria-label="Legenda da topologia">
            <span><i data-tone="active" /> Configurado</span>
            <span><i data-tone="attention" /> Requer atenção</span>
            <span><i data-tone="live-up" /> Responde</span>
            <span><i data-tone="live-down" /> Não responde</span>
            <span><b /> Ligação definida</span>
            <span><b data-medium="fibra" /> Fibra</span>
            <span><b data-medium="radio" /> Rádio</span>
            <small>As linhas são administrativas. O ponto no canto é a última leitura da sonda; sem ponto, ninguém mediu.</small>
          </div>
        )}
      </section>
    );
  }
);

export const TopologyCanvas = forwardRef<TopologyCanvasHandle, TopologyCanvasProps>(
  function TopologyCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <TopologyCanvasInner {...props} ref={ref} />
      </ReactFlowProvider>
    );
  }
);
