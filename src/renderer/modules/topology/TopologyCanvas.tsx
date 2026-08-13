import {
  Background,
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
  useRef
} from 'react';
import type { ForwardedRef } from 'react';
import { isValidBackboneConnection } from './backbone-linking';
import type { TopologyFlowEdge } from './topology-graph';
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
  /** Permite arrastar uma ligação entre unidades de backbone. */
  connectable?: boolean;
  onConnectNodes?: (sourceNodeId: string, targetNodeId: string) => void;
};

function motionDuration(): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 260;
}

function miniMapColor(node: TopologyCanvasNode): string {
  if (node.data.topology.issueCodes.length > 0) return 'var(--warn)';
  if (node.type === 'logical-root') return 'var(--accent)';
  if (node.type === 'backbone') return 'var(--accent-2)';
  return 'var(--text-3)';
}

function useCanvasControls(
  ref: ForwardedRef<TopologyCanvasHandle>,
  nodes: TopologyCanvasNode[]
) {
  const flow = useReactFlow<TopologyCanvasNode, TopologyFlowEdge>();
  const nodesInitialized = useNodesInitialized();
  const fittedCount = useRef(0);
  useImperativeHandle(ref, () => ({
    fit: () => void flow.fitView({ padding: 0.18, duration: motionDuration() }),
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
    void flow.fitView({ padding: 0.2, duration: 0 });
  }, [flow, nodes.length, nodesInitialized]);
}

const TopologyCanvasInner = forwardRef<TopologyCanvasHandle, TopologyCanvasProps>(
  function TopologyCanvasInner({
    nodes,
    edges,
    legendVisible,
    connectable = false,
    onConnectNodes
  }, ref) {
    useCanvasControls(ref, nodes);

    return (
      <div className="topology-canvas" aria-label="Mapa físico da rede">
        {/* Sem `panOnScroll`: com ele o React Flow desloca a vista com a roda e
            manda o zoom para trás de Ctrl. Aqui a roda aproxima e o arrasto
            desloca, como em qualquer mapa. */}
        <ReactFlow<TopologyCanvasNode, TopologyFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={topologyNodeTypes}
          nodesDraggable={false}
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
          selectionKeyCode={null}
          minZoom={0.25}
          maxZoom={2.5}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
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
          <MiniMap
            className="topology-minimap"
            style={{ width: 180, height: 120 }}
            pannable
            zoomable
            nodeColor={miniMapColor}
            maskColor="color-mix(in oklch, var(--bg) 72%, transparent)"
          />
        </ReactFlow>
        {legendVisible && (
          <div className="topology-legend" aria-label="Legenda da topologia">
            <span><i data-tone="active" /> Configurado</span>
            <span><i data-tone="attention" /> Requer atenção</span>
            <span><i data-tone="live-up" /> De pé</span>
            <span><i data-tone="live-down" /> Não responde</span>
            <span><b /> Ligação definida</span>
            <small>As linhas são administrativas. O ponto no canto é a última leitura da sonda; sem ponto, ninguém mediu.</small>
          </div>
        )}
      </div>
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
