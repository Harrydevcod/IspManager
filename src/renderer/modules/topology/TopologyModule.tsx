import './TopologyModule.css';

import { lazy, Suspense, useCallback, useState } from 'react';
import { TabList } from '../../components';
import { BackboneWorkspace, type BackbonePrefill } from './BackboneWorkspace';
import { DiscoveryWorkspace } from './discovery/DiscoveryWorkspace';
import { IncidentsWorkspace } from './IncidentsWorkspace';
import type { TopologyApi } from './topology-api';

const TopologyMapView = lazy(() => import('./TopologyMapView'));

export type TopologyModuleProps = {
  api?: TopologyApi;
  /** A aba em que o módulo abre; o painel inicial manda abrir nos Incidentes. */
  initialTab?: 'incidents';
  onOpenClient: (clientId: number) => void;
  /**
   * O `assignmentId` é opcional porque só a Descoberta o sabe: o mapa manda
   * abrir o serviço, a proposta de modelo manda abrir o equipamento dentro dele.
   */
  onOpenService: (clientId: number, serviceId: number, assignmentId?: number) => void;
  onOpenStock: (catalogId: number) => void;
};

type TopologyTab = 'backbone' | 'topology' | 'discovery' | 'incidents';

const tabs: ReadonlyArray<{ id: TopologyTab; label: string }> = [
  { id: 'backbone', label: 'Backbone' },
  { id: 'topology', label: 'Topologia' },
  { id: 'discovery', label: 'Descoberta' },
  { id: 'incidents', label: 'Incidentes' }
];

function MapLoadingFallback() {
  return (
    <section className="topology-tab-loading" role="status" aria-label="A preparar topologia">
      <span aria-hidden />
      <p>A preparar o mapa físico…</p>
    </section>
  );
}

export default function TopologyModule(props: TopologyModuleProps) {
  const [activeTab, setActiveTab] = useState<TopologyTab>(props.initialTab ?? 'backbone');
  const [revision, setRevision] = useState(0);
  const [backboneRevision, setBackboneRevision] = useState(0);
  const [focusBackboneDeviceId, setFocusBackboneDeviceId] = useState<number | null>(null);
  const [mapVisited, setMapVisited] = useState(false);
  const [discoveryVisited, setDiscoveryVisited] = useState(false);
  const [backbonePrefill, setBackbonePrefill] = useState<BackbonePrefill | null>(null);
  // Os controlos do mapa entram aqui por portal: pertencem ao mapa, mas o sítio
  // onde não tapam o grafo é a tira das abas, que é deste componente.
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const selectTab = useCallback((tab: TopologyTab) => {
    if (tab === 'topology') setMapVisited(true);
    if (tab === 'discovery') setDiscoveryVisited(true);
    setActiveTab(tab);
  }, []);

  // Vem da Descoberta: abre o formulário de backbone na aba ao lado, já com o
  // endereço e o MAC que foram encontrados na rede.
  const handleRegisterBackbone = useCallback((prefill: BackbonePrefill) => {
    setBackbonePrefill(prefill);
    setActiveTab('backbone');
  }, []);

  const handlePrefillHandled = useCallback(() => setBackbonePrefill(null), []);

  function handleMutation() {
    setFocusBackboneDeviceId(null);
    setRevision((current) => current + 1);
  }

  // O mapa já se recarrega sozinho; aqui só se avisa a lista da outra aba.
  const handleMapMutation = useCallback(
    () => setBackboneRevision((current) => current + 1),
    []
  );

  function handleViewTopology(backboneDeviceId: number) {
    setFocusBackboneDeviceId(backboneDeviceId);
    selectTab('topology');
  }

  const handleFocusHandled = useCallback(() => setFocusBackboneDeviceId(null), []);

  return (
    <section className="topology-shell" aria-label="Infraestrutura de backbone e topologia">
      <div className="topology-tabs">
        <TabList
          className="topology-tabs-list"
          idPrefix="topology"
          label="Vistas de infraestrutura"
          tabs={tabs}
          value={activeTab}
          onChange={selectTab}
        />
        {/* Só na aba do mapa: na aba Backbone o slot não existe e os controlos
            saem da tira sem ninguém ter de os esconder. */}
        {activeTab === 'topology' && (
          <div className="topology-tabs-tools" ref={setToolsSlot} />
        )}
      </div>

      <div
        id="topology-panel-backbone"
        className="topology-tab-panel"
        role="tabpanel"
        aria-labelledby="topology-tab-backbone"
        hidden={activeTab !== 'backbone'}
      >
        <BackboneWorkspace
          revision={backboneRevision}
          onMutation={handleMutation}
          onViewTopology={handleViewTopology}
          prefill={backbonePrefill}
          onPrefillHandled={handlePrefillHandled}
        />
      </div>

      <div
        id="topology-panel-topology"
        className="topology-tab-panel topology-map-panel"
        role="tabpanel"
        aria-labelledby="topology-tab-topology"
        hidden={activeTab !== 'topology'}
      >
        {mapVisited && (
          <Suspense fallback={<MapLoadingFallback />}>
            <TopologyMapView
              {...props}
              revision={revision}
              active={activeTab === 'topology'}
              focusBackboneDeviceId={focusBackboneDeviceId}
              onFocusHandled={handleFocusHandled}
              onMutation={handleMapMutation}
              toolsSlot={toolsSlot}
              /* "Sem ligação" no mapa conta equipamento que ainda não diz de
                 que backbone pende. Define-se na aba ao lado, a mesma porta
                 que a Descoberta já usa. */
              onOpenBackbone={() => selectTab('backbone')}
            />
          </Suspense>
        )}
      </div>

      <div
        id="topology-panel-discovery"
        className="topology-tab-panel"
        role="tabpanel"
        aria-labelledby="topology-tab-discovery"
        hidden={activeTab !== 'discovery'}
      >
        {/* Sem `lazy`: a Descoberta é tabela e cartões, já no bundle. A guarda
            de visita existe só para não pedir a rede a quem nunca abriu a aba. */}
        {discoveryVisited && (
          <DiscoveryWorkspace
            active={activeTab === 'discovery'}
            onRegisterBackbone={handleRegisterBackbone}
            onOpenService={props.onOpenService}
            onOpenBackbone={() => selectTab('backbone')}
          />
        )}
      </div>

      <div
        id="topology-panel-incidents"
        className="topology-tab-panel"
        role="tabpanel"
        aria-labelledby="topology-tab-incidents"
        hidden={activeTab !== 'incidents'}
      >
        {/* `active` desliga o pedido: quem nunca abre a aba nunca o faz. */}
        <IncidentsWorkspace active={activeTab === 'incidents'} />
      </div>
    </section>
  );
}
