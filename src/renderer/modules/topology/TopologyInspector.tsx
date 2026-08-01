import {
  ArrowUpRight,
  Box,
  Network,
  RadioTower,
  X
} from 'lucide-react';
import type {
  TopologyBackboneBranch,
  TopologyClientDeviceNode,
  TopologyIssueCode,
  TopologyNode,
  TopologySnapshot
} from '../../../shared/topology';
import { Button } from '../../components';
import { statusLabel } from '../../lib/status';

export type TopologyInspectorProps = {
  node: TopologyNode | null;
  snapshot: TopologySnapshot;
  branch?: TopologyBackboneBranch;
  onClose: () => void;
  onOpenClient: (clientId: number) => void;
  onOpenService: (clientId: number, serviceId: number) => void;
  onOpenStock: (catalogId: number) => void;
  /** Ausente para quem não pode gerir: as alimentações ficam só de leitura. */
  onDisconnectUpstream?: (deviceId: number, upstreamDeviceId: number) => void;
};

const ISSUE_LABELS: Record<TopologyIssueCode, string> = {
  inactive: 'Inativo',
  missing_ip: 'IP em falta',
  suspended_service: 'Serviço suspenso',
  incomplete_configuration: 'Configuração incompleta',
  provisional_identity: 'Identidade provisória'
};

function kindLabel(node: TopologyNode): string {
  if (node.kind === 'logical-root') return 'Núcleo lógico';
  if (node.kind === 'backbone') return 'Equipamento backbone';
  return 'Equipamento de cliente';
}

function KindIcon({ node }: { node: TopologyNode }) {
  if (node.kind === 'logical-root') return <Network size={18} aria-hidden />;
  if (node.kind === 'backbone') return <RadioTower size={18} aria-hidden />;
  return <Box size={18} aria-hidden />;
}

function Detail({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="topology-inspector-detail">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StateBadges({ node }: { node: TopologyNode }) {
  return (
    <div className="topology-inspector-badges">
      <span data-tone={node.administrativeState === 'active' ? 'active' : 'inactive'}>
        {node.administrativeState === 'active' ? 'Ativo' : 'Inativo'}
      </span>
      {node.issueCodes.map((issue) => (
        <span data-tone="attention" key={issue}>{ISSUE_LABELS[issue]}</span>
      ))}
    </div>
  );
}

function RootDetails({ snapshot }: { snapshot: TopologySnapshot }) {
  // Quantas unidades recebem sinal directamente da Internet: cada uma é uma
  // origem própria (outra ilha, outra zona, ou reforço de capacidade no mesmo sítio).
  const uplinkCount = snapshot.backbones
    .filter((item) => item.parentIds.includes('root:isp')).length;
  return (
    <dl className="topology-inspector-details">
      <Detail label="Ligações à Internet" value={uplinkCount} />
      <Detail label="Backbones" value={snapshot.stats.backboneCount} />
      <Detail label="CPE físicas" value={snapshot.stats.assignmentCount} />
      <Detail label="Com ligação" value={snapshot.stats.mappedAssignmentCount} />
      <Detail label="Sem ligação" value={snapshot.stats.unmappedAssignmentCount} />
      <Detail label="Clientes associados" value={snapshot.stats.clientCount} />
      <Detail label="Serviços associados" value={snapshot.stats.serviceCount} />
      <Detail label="Com atenção" value={snapshot.stats.attentionCount} />
      <Detail label="Gerado em" value={new Date(snapshot.generatedAt).toLocaleString('pt-PT')} />
    </dl>
  );
}

function UpstreamList({
  node,
  snapshot,
  onDisconnect
}: {
  node: Extract<TopologyNode, { kind: 'backbone' }>;
  snapshot: TopologySnapshot;
  onDisconnect?: (deviceId: number, upstreamDeviceId: number) => void;
}) {
  // Várias alimentações = agregação multi-WAN (por exemplo duas Starlink no
  // mesmo router). Sem nenhuma no mapa, a unidade recebe da Internet.
  const upstreams = node.parentIds
    .flatMap((parentId) => snapshot.backbones.filter((item) => item.id === parentId));
  return (
    <div className="topology-inspector-detail topology-inspector-uplinks">
      <dt>{upstreams.length > 1 ? 'Alimentado por (multi-WAN)' : 'Alimentado por'}</dt>
      <dd>
        {upstreams.length === 0 ? 'Internet' : (
          <ul>
            {upstreams.map((upstream) => (
              <li key={upstream.id}>
                <span>{upstream.label}</span>
                {onDisconnect && (
                  <Button
                    variant="icon"
                    size="sm"
                    aria-label={`Remover alimentação de ${upstream.label}`}
                    onClick={() => onDisconnect(node.backboneDeviceId, upstream.backboneDeviceId)}
                  >
                    <X size={12} aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

function BackboneDetails({
  node,
  snapshot,
  branch,
  onOpenStock,
  onDisconnectUpstream
}: {
  node: Extract<TopologyNode, { kind: 'backbone' }>;
  snapshot: TopologySnapshot;
  branch?: TopologyBackboneBranch;
  onOpenStock: (catalogId: number) => void;
  onDisconnectUpstream?: (deviceId: number, upstreamDeviceId: number) => void;
}) {
  return (
    <>
      <dl className="topology-inspector-details">
        <Detail label="Unidade física" value={`#${node.backboneDeviceId}`} />
        <UpstreamList node={node} snapshot={snapshot} onDisconnect={onDisconnectUpstream} />
        <Detail label="Catálogo" value={`#${node.catalogId}`} />
        <Detail label="Tipo" value={node.catalogType} />
        <Detail label="Marca" value={node.brand ?? 'Não indicada'} />
        <Detail label="Modelo" value={node.model} />
        <Detail label="Serial" value={node.serialNumber ?? 'Não indicado'} />
        <Detail label="Asset tag" value={node.assetTag ?? 'Não indicado'} />
        <Detail label="IP configurado" value={node.ipAddress ?? 'Em falta'} />
        <Detail label="MAC" value={node.macAddress ?? 'Não indicado'} />
        <Detail
          label="Localização"
          value={[node.island, node.zone].filter(Boolean).join(' · ') || 'Não indicada'}
        />
        <Detail label="Identidade" value={node.provisional ? 'Provisória' : 'Confirmada'} />
        <Detail label="CPE no ramo" value={branch?.stats.assignmentCount ?? 'Ramo fechado'} />
      </dl>
      <Button
        variant="secondary"
        className="topology-inspector-action"
        onClick={() => onOpenStock(node.catalogId)}
      >
        Abrir no Stock <ArrowUpRight size={14} aria-hidden />
      </Button>
    </>
  );
}

function DeviceDetails({
  node,
  onOpenStock
}: {
  node: TopologyClientDeviceNode;
  onOpenStock: (catalogId: number) => void;
}) {
  return (
    <>
      <dl className="topology-inspector-details">
        <Detail label="Atribuição física" value={`#${node.assignmentId}`} />
        <Detail label="Modelo" value={`${node.brand ? `${node.brand} ` : ''}${node.model}`} />
        <Detail label="Serial" value={node.serialNumber ?? 'Não indicado'} />
        <Detail label="Asset tag" value={node.assetTag ?? 'Não indicado'} />
        <Detail label="IP configurado" value={node.ipAddress ?? 'Em falta'} />
        <Detail label="MAC" value={node.macAddress ?? 'Não indicado'} />
        <Detail label="Desde" value={node.startDate} />
        <Detail
          label="Ligação"
          value={node.parentId === 'root:isp'
            ? 'Sem ligação definida'
            : `Backbone físico #${node.parentId.slice('backbone:'.length)}`}
        />
      </dl>
      <Button
        variant="secondary"
        className="topology-inspector-action"
        onClick={() => onOpenStock(node.catalogId)}
      >
        Abrir no Stock <ArrowUpRight size={14} aria-hidden />
      </Button>
    </>
  );
}

function ClientAssociations({
  node,
  onOpenClient,
  onOpenService
}: Pick<TopologyInspectorProps, 'onOpenClient' | 'onOpenService'> & {
  node: TopologyClientDeviceNode;
}) {
  return (
    <section className="topology-associations" aria-labelledby="topology-clients-title">
      <h4 id="topology-clients-title">Clientes e serviços associados</h4>
      {node.clients.map((client) => (
        <article className="topology-client-association" key={client.id}>
          <header>
            <span>
              <small>{client.clientCode}</small>
              <strong>{client.fullName}</strong>
            </span>
            <Button variant="ghost" size="sm" onClick={() => onOpenClient(client.id)}>
              Abrir cliente
            </Button>
          </header>
          <p>{[client.island, client.zone].filter(Boolean).join(' · ') || 'Localização não indicada'}</p>
          <ul>
            {client.services.map((service) => (
              <li key={service.id}>
                <span>
                  <strong>{service.planName ?? `Serviço #${service.id}`}</strong>
                  <small>{statusLabel(service.status)} · serviço #{service.id}</small>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenService(client.id, service.id)}
                >
                  Abrir serviço
                </Button>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}

function EmptyInspector() {
  return (
    <div className="topology-inspector-empty">
      <span className="topology-inspector-crosshair" aria-hidden />
      <p className="eyebrow">Inspetor persistente</p>
      <h3>Seleciona um nó</h3>
      <p>
        Consulta configuração, estado administrativo e associações sem sair do mapa.
      </p>
    </div>
  );
}

export function TopologyInspector(props: TopologyInspectorProps) {
  const { node, snapshot, branch, onClose, onOpenStock } = props;
  return (
    <aside className="topology-inspector" aria-label="Inspetor da topologia">
      {!node ? <EmptyInspector /> : (
        <>
          <header className="topology-inspector-head">
            <span className="topology-inspector-kind"><KindIcon node={node} /></span>
            <div>
              <p className="eyebrow">{kindLabel(node)}</p>
              <h3>{node.label}</h3>
            </div>
            <Button
              variant="icon"
              size="sm"
              className="topology-inspector-close"
              aria-label="Fechar inspetor"
              onClick={onClose}
            >
              <X size={16} aria-hidden />
            </Button>
          </header>
          <StateBadges node={node} />
          {node.kind === 'logical-root' && <RootDetails snapshot={snapshot} />}
          {node.kind === 'backbone' && (
            <BackboneDetails
              node={node}
              snapshot={snapshot}
              branch={branch}
              onOpenStock={onOpenStock}
              onDisconnectUpstream={props.onDisconnectUpstream}
            />
          )}
          {node.kind === 'client-device' && (
            <>
              <DeviceDetails node={node} onOpenStock={onOpenStock} />
              <ClientAssociations
                node={node}
                onOpenClient={props.onOpenClient}
                onOpenService={props.onOpenService}
              />
            </>
          )}
          <p className="topology-lineage-note">
            Este mapa representa ligações definidas e configuração administrativa;
            não representa reachability nem telemetria em tempo real.
          </p>
        </>
      )}
    </aside>
  );
}
