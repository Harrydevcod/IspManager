import {
  AlertTriangle,
  Box,
  ChevronRight,
  Loader2,
  Network,
  RadioTower,
  RotateCw,
  User
} from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { KeyboardEvent } from 'react';
import type { TopologyNode } from '../../../shared/topology';
import { Button } from '../../components';
import type { TopologyFlowNodeData } from './topology-graph';
import type { TopologyDirection } from './topology-layout';

export type TopologyNodeContentProps = {
  node: TopologyNode;
  selected: boolean;
  expanded?: boolean;
  loading?: boolean;
  error?: string;
  branchCount?: number;
  /** Direção do mapa: manda no lado por onde o ramo abre. */
  flow?: TopologyDirection;
  onSelect: () => void;
  onToggle?: () => void;
  onRetry?: () => void;
};

/** `flow` vem do layout, não do estado do workspace — fica fora do `data.ui`. */
export type TopologyNodeUi = Omit<
  TopologyNodeContentProps,
  'node' | 'selected' | 'flow'
>;

export type TopologyCanvasNodeData = TopologyFlowNodeData & {
  ui: TopologyNodeUi;
};

export type TopologyCanvasNode = Node<
  TopologyCanvasNodeData,
  TopologyNode['kind']
>;

function nodeMeta(node: TopologyNode, branchCount?: number): string {
  if (node.kind === 'logical-root') return 'Raiz lógica · mapa físico';
  if (node.kind === 'client') {
    return [node.clientCode, node.planName ?? 'Sem plano'].join(' · ');
  }
  if (node.kind === 'backbone') {
    const count = branchCount === undefined ? 'Ramo por carregar' : `${branchCount} equipamentos`;
    const location = [node.island, node.zone].filter(Boolean).join(' · ');
    return [
      node.model,
      node.ipAddress ?? 'IP em falta',
      location || 'Localização em falta',
      count
    ].join(' · ');
  }
  const clientCount = node.clients.length;
  return `${node.ipAddress ?? 'IP em falta'} · ${clientCount} cliente${clientCount === 1 ? '' : 's'}`;
}

function nodeStatusLabel(node: TopologyNode): string {
  if (node.issueCodes.length > 0) return `${node.issueCodes.length} atenção`;
  return node.administrativeState === 'active' ? 'Ativo' : 'Inativo';
}

function nodeIcon(node: TopologyNode) {
  if (node.kind === 'logical-root') return <Network size={17} aria-hidden />;
  if (node.kind === 'backbone') return <RadioTower size={17} aria-hidden />;
  if (node.kind === 'client') return <User size={16} aria-hidden />;
  return <Box size={16} aria-hidden />;
}

function selectWithEnter(
  event: KeyboardEvent<HTMLButtonElement>,
  onSelect: () => void
): void {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  onSelect();
}

function BranchControl({
  node,
  expanded,
  loading,
  onToggle
}: Pick<TopologyNodeContentProps, 'node' | 'expanded' | 'loading' | 'onToggle'>) {
  if (node.kind !== 'backbone' || !onToggle) return null;
  const verb = expanded ? 'Recolher' : 'Expandir';
  return (
    <Button
      variant="icon"
      className="topology-node-expand nodrag nopan"
      aria-label={`${verb} ramo ${node.label}`}
      aria-expanded={expanded}
      disabled={loading}
      onClick={onToggle}
    >
      {loading
        ? <Loader2 size={14} className="topology-spin" aria-hidden />
        : <ChevronRight size={15} aria-hidden />}
    </Button>
  );
}

function NodeSelectControl({
  node,
  branchCount,
  onSelect
}: Pick<TopologyNodeContentProps, 'node' | 'branchCount' | 'onSelect'>) {
  return (
    <Button
      variant="ghost"
      className="topology-node-select nodrag nopan"
      data-topology-select
      aria-label={`Selecionar ${node.label}`}
      onClick={onSelect}
      onKeyDown={(event) => selectWithEnter(event, onSelect)}
    >
      <span className="topology-node-glyph">{nodeIcon(node)}</span>
      <span className="topology-node-copy">
        <strong>{node.label}</strong>
        <small>{nodeMeta(node, branchCount)}</small>
      </span>
      <span className="topology-node-state">
        {node.issueCodes.length > 0 && <AlertTriangle size={11} aria-hidden />}
        {nodeStatusLabel(node)}
      </span>
    </Button>
  );
}

function NodeBranchError({
  node,
  error,
  onRetry
}: Pick<TopologyNodeContentProps, 'node' | 'error' | 'onRetry'>) {
  if (!error || node.kind !== 'backbone') return null;
  return (
    <div className="topology-node-error" role="alert">
      <span>Não foi possível carregar este ramo.</span>
      <Button
        variant="ghost"
        size="sm"
        className="nodrag nopan"
        aria-label={`Tentar novamente ${node.label}`}
        onClick={onRetry}
      >
        <RotateCw size={12} aria-hidden /> Repetir
      </Button>
    </div>
  );
}

export function TopologyNodeContent({
  node,
  selected,
  expanded = false,
  loading = false,
  error,
  branchCount,
  flow = 'LR',
  onSelect,
  onToggle,
  onRetry
}: TopologyNodeContentProps) {
  // Sem sonda não há ponto: a raiz é lógica e um cliente é uma pessoa.
  const liveState = 'liveState' in node ? node.liveState ?? undefined : undefined;
  return (
    <article
      className="topology-node"
      data-kind={node.kind}
      data-flow={flow}
      data-state={node.issueCodes.length > 0 ? 'attention' : node.administrativeState}
      data-live={liveState}
      data-selected={selected || undefined}
    >
      <NodeSelectControl node={node} branchCount={branchCount} onSelect={onSelect} />
      <BranchControl
        node={node}
        expanded={expanded}
        loading={loading}
        onToggle={onToggle}
      />
      <NodeBranchError node={node} error={error} onRetry={onRetry} />
    </article>
  );
}

/**
 * As âncoras vêm do layout: viram com a orientação do mapa. Só a espinha dorsal
 * aceita o gesto de ligar — as CPE dependem de uma atribuição de serviço.
 */
function NodeHandles({ kind, source, target, connectable }: {
  kind: TopologyNode['kind'];
  source: Position;
  target: Position;
  connectable: boolean;
}) {
  const spine = connectable && kind !== 'client-device' && kind !== 'client';
  return (
    <>
      {kind !== 'logical-root' && (
        <Handle type="target" position={target} isConnectable={spine} />
      )}
      {/* Só uma pessoa não tem jusante. A antena do cliente tem: o router dele
          pendura-se nela, e sem esta âncora a linha não tinha onde encostar. */}
      {kind !== 'client' && (
        <Handle type="source" position={source} isConnectable={spine} />
      )}
    </>
  );
}

function TopologyNodeRenderer({
  data,
  selected,
  isConnectable,
  sourcePosition,
  targetPosition
}: NodeProps<TopologyCanvasNode>) {
  return (
    <>
      <NodeHandles
        kind={data.topology.kind}
        source={sourcePosition ?? Position.Right}
        target={targetPosition ?? Position.Left}
        connectable={isConnectable}
      />
      <TopologyNodeContent
        node={data.topology}
        selected={selected}
        flow={sourcePosition === Position.Bottom ? 'TB' : 'LR'}
        {...data.ui}
      />
    </>
  );
}

export const topologyNodeTypes = {
  'logical-root': TopologyNodeRenderer,
  backbone: TopologyNodeRenderer,
  'client-device': TopologyNodeRenderer,
  client: TopologyNodeRenderer
};
