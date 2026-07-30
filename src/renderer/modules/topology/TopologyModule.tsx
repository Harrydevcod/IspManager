import './TopologyModule.css';

import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '../../components';
import { BackboneWorkspace } from './BackboneWorkspace';
import type { TopologyApi } from './topology-api';

const TopologyMapView = lazy(() => import('./TopologyMapView'));

export type TopologyModuleProps = {
  api?: TopologyApi;
  onOpenClient: (clientId: number) => void;
  onOpenService: (clientId: number, serviceId: number) => void;
  onOpenStock: (catalogId: number) => void;
};

type TopologyTab = 'backbone' | 'topology';

const tabs: ReadonlyArray<{ id: TopologyTab; label: string }> = [
  { id: 'backbone', label: 'Backbone' },
  { id: 'topology', label: 'Topologia' }
];

function MapLoadingFallback() {
  return (
    <section className="topology-tab-loading" aria-label="A preparar topologia">
      <span />
      <p>A preparar o mapa físico…</p>
    </section>
  );
}

export default function TopologyModule(props: TopologyModuleProps) {
  const [activeTab, setActiveTab] = useState<TopologyTab>('backbone');
  const [revision, setRevision] = useState(0);
  const [focusBackboneDeviceId, setFocusBackboneDeviceId] = useState<number | null>(null);
  const [mapVisited, setMapVisited] = useState(false);
  const tabListRef = useRef<HTMLDivElement>(null);

  const selectTab = useCallback((tab: TopologyTab, moveFocus = false) => {
    if (tab === 'topology') setMapVisited(true);
    setActiveTab(tab);
    if (moveFocus) {
      queueMicrotask(() => {
        tabListRef.current
          ?.querySelector<HTMLButtonElement>(`#topology-tab-${tab}`)
          ?.focus();
      });
    }
  }, []);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextTab: TopologyTab = activeTab === 'backbone' ? 'topology' : 'backbone';
    selectTab(nextTab, true);
  }

  function handleMutation() {
    setFocusBackboneDeviceId(null);
    setRevision((current) => current + 1);
  }

  function handleViewTopology(backboneDeviceId: number) {
    setFocusBackboneDeviceId(backboneDeviceId);
    selectTab('topology');
  }

  const handleFocusHandled = useCallback(() => setFocusBackboneDeviceId(null), []);

  return (
    <section className="topology-shell" aria-label="Infraestrutura de backbone e topologia">
      <div
        ref={tabListRef}
        className="topology-tabs"
        role="tablist"
        aria-label="Vistas de infraestrutura"
      >
        {tabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <Button
              key={tab.id}
              id={`topology-tab-${tab.id}`}
              variant="ghost"
              role="tab"
              aria-selected={selected}
              aria-controls={`topology-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={handleTabKeyDown}
            >
              {tab.label}
            </Button>
          );
        })}
      </div>

      <div
        id="topology-panel-backbone"
        className="topology-tab-panel"
        role="tabpanel"
        aria-labelledby="topology-tab-backbone"
        hidden={activeTab !== 'backbone'}
      >
        <BackboneWorkspace
          onMutation={handleMutation}
          onViewTopology={handleViewTopology}
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
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}
