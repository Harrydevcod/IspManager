import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow
} from '@xyflow/react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef
} from 'react';
import type { ForwardedRef } from 'react';
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
};

function motionDuration(): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 260;
}

function miniMapColor(node: TopologyCanvasNode): string {
  if (node.data.topology.issueCodes.length > 0) return 'oklch(69% 0.12 78)';
  if (node.type === 'logical-root') return 'oklch(66% 0.09 151)';
  if (node.type === 'backbone') return 'oklch(58% 0.08 151)';
  return 'oklch(55% 0.025 145)';
}

function useCanvasControls(
  ref: ForwardedRef<TopologyCanvasHandle>,
  nodes: TopologyCanvasNode[]
) {
  const flow = useReactFlow<TopologyCanvasNode, TopologyFlowEdge>();
  const didInitialFit = useRef(false);
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
  useEffect(() => {
    if (didInitialFit.current || nodes.length === 0) return;
    didInitialFit.current = true;
    const frame = window.requestAnimationFrame(() => {
      void flow.fitView({ padding: 0.2, duration: motionDuration() });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow, nodes.length]);
}

const TopologyCanvasInner = forwardRef<TopologyCanvasHandle, TopologyCanvasProps>(
  function TopologyCanvasInner({ nodes, edges, legendVisible }, ref) {
    useCanvasControls(ref, nodes);

    return (
      <div className="topology-canvas" aria-label="Mapa físico da rede">
        <ReactFlow<TopologyCanvasNode, TopologyFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={topologyNodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          minZoom={0.35}
          maxZoom={1.8}
          panOnDrag
          panOnScroll
          zoomOnScroll
          zoomOnPinch
          fitView={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color="oklch(42% 0.018 145)"
          />
          <MiniMap
            className="topology-minimap"
            pannable
            zoomable
            nodeColor={miniMapColor}
            maskColor="oklch(15% 0.012 145 / 0.72)"
          />
        </ReactFlow>
        {legendVisible && (
          <div className="topology-legend" aria-label="Legenda da topologia">
            <span><i data-tone="active" /> Configurado</span>
            <span><i data-tone="attention" /> Requer atenção</span>
            <span><b /> Ligação definida</span>
            <small>As linhas são administrativas; não indicam conectividade em tempo real.</small>
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
