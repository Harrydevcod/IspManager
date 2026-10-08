import { AlertTriangle, Cable, Cpu, Gauge, Layers, MemoryStick, Router, ScrollText, Settings2, ShieldAlert, Timer, Waypoints, X, ChartNoAxesCombined, History } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Badge, Button, EmptyState, ErrorRetry, MetricCard, MetricGrid, ModuleHeaderActions, SkeletonList } from '../../components';
import { formatPtDateTime } from '../../lib/format';
import type { PlanRow } from '../../types';
import { SettingsModule } from '../SettingsModule';
import {
  formatBytes,
  profileRows,
  ROUTER_API,
  type Live,
  type RouterInterface,
  type RouterLog,
  type RouterOverview,
  type RouterProfileOption,
  type RouterSession,
  type RouterWanUsage
} from './router-api';
import { InterfacesTable, LogView, ProfilesTable, SessionsTable } from './RouterTables';
import { StoredLog } from './StoredLog';
import { SyncStatus } from './SyncStatus';
import { useLive } from './useLive';
import { PRESENCE_URL, presenceMessage, type NetworkPresence } from '../../lib/networkPresence';
import { WanTraffic } from './WanTraffic';
import { WanUsage } from './WanUsage';
import { ClientUsage, type ClientUsageRow } from './ClientUsage';
import { ConfigBackups, type ConfigSnapshots } from './ConfigBackups';
import './RouterModule.css';

type RouterTab = 'overview' | 'sessions' | 'profiles' | 'interfaces' | 'consumption' | 'backups' | 'log' | 'config';

const TABS: ReadonlyArray<{ id: RouterTab; label: string; icon: typeof Router }> = [
  { id: 'overview', label: 'Visão geral', icon: Gauge },
  { id: 'sessions', label: 'Sessões PPPoE', icon: Cable },
  { id: 'profiles', label: 'Perfis PPP', icon: Layers },
  { id: 'interfaces', label: 'Interfaces', icon: Waypoints },
  { id: 'consumption', label: 'Consumo', icon: ChartNoAxesCombined },
  { id: 'backups', label: 'Cópias', icon: History },
  { id: 'log', label: 'Registo', icon: ScrollText },
  { id: 'config', label: 'Configuração', icon: Settings2 }
];

type LogViewId = 'live' | 'stored';
const LOG_VIEWS: ReadonlyArray<{ id: LogViewId; label: string }> = [
  { id: 'live', label: 'Ao vivo' },
  { id: 'stored', label: 'Guardado' }
];

function percent(used: number, total: number) {
  return `${Math.round((used / total) * 100)}%`;
}

function Unavailable({ reason, onConfigure }: { reason: string; onConfigure: () => void }) {
  return (
    <EmptyState
      icon={Router}
      title="Router de gestão do ISP indisponível"
      description={reason}
      action={<Button variant="secondary" leadingIcon={<Settings2 size={14} aria-hidden />} onClick={onConfigure}>Abrir configuração</Button>}
    />
  );
}

/** O estado comum a todas as vistas ao vivo: a carregar, falhou, router indisponível. */
function LiveGate<T>({ live, onRetry, onConfigure, presence, children }: {
  live: { data: Live<T> | null; error: string | null };
  onRetry: () => void;
  onConfigure: () => void;
  presence?: NetworkPresence | null;
  children: (data: T & { dryRun: boolean }) => ReactNode;
}) {
  if (live.error && !live.data) return <ErrorRetry message={live.error} onRetry={onRetry} />;
  if (!live.data) return <SkeletonList rows={5} />;
  if (!live.data.available) return <Unavailable reason={presence && (presence.state === 'offsite' || presence.state === 'foreign') ? presenceMessage(presence) : live.data.reason} onConfigure={onConfigure} />;
  return children(live.data);
}

function Overview({ data, onOpen }: { data: RouterOverview & { dryRun: boolean }; onOpen: (tab: RouterTab) => void }) {
  const { system } = data;
  const usedMemory = system.totalMemory !== null && system.freeMemory !== null ? system.totalMemory - system.freeMemory : null;
  // Uma só leitura do acumulado: os cartões ao vivo e o histórico partilham-na.
  const usage = useLive<RouterWanUsage>(`${ROUTER_API}/wan/usage`, true, 60_000);
  return (
    <>
      <WanTraffic usage={usage.data} />
      <WanUsage live={usage} />
      <MetricGrid label="Estado do router">
        <MetricCard
          icon={Cable}
          label="Sessões ativas"
          value={String(data.activeSessions)}
          trend={`de ${data.secrets} secrets${data.disabledSecrets ? ` · ${data.disabledSecrets} desativados` : ''}`}
          tone="success"
          onActivate={() => onOpen('sessions')}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Divergências"
          value={String(data.divergences)}
          trend={data.divergences ? 'ISPM e router discordam' : 'ISPM e router de acordo'}
          tone={data.divergences ? 'danger' : 'neutral'}
          onActivate={() => onOpen('sessions')}
        />
        <MetricCard icon={Cpu} label="CPU" value={system.cpuLoad === null ? '—' : `${system.cpuLoad}%`} trend={system.architecture ?? undefined} tone={system.cpuLoad !== null && system.cpuLoad >= 80 ? 'warning' : 'info'} />
        <MetricCard
          icon={MemoryStick}
          label="Memória"
          value={usedMemory === null || !system.totalMemory ? '—' : percent(usedMemory, system.totalMemory)}
          trend={usedMemory === null ? undefined : `${formatBytes(usedMemory)} de ${formatBytes(system.totalMemory)}`}
          tone="info"
        />
        <MetricCard
          icon={Timer}
          label="Ligado há"
          value={system.uptime ?? '—'}
          trend={data.lastEnforcement ? `reconciliou ${formatPtDateTime(data.lastEnforcement.ranAt)}` : 'ainda sem reconciliação'}
          tone={data.lastEnforcement?.status === 'error' ? 'danger' : 'neutral'}
        />
      </MetricGrid>

      <section className="router-findings" aria-label="Serviços abertos no router">
        <h3><ShieldAlert size={16} aria-hidden /> Serviços abertos no router</h3>
        {data.findings.length === 0 ? (
          <p className="router-muted">Nada a apontar: os serviços de gestão do router estão fechados ou restritos.</p>
        ) : (
          <ol className="settings-router-steps">
            {data.findings.map((finding) => (
              <li key={finding.services.join(',')} data-status={finding.severity === 'grave' ? 'fail' : 'warn'}>
                {finding.severity === 'grave'
                  ? <X size={14} aria-hidden className="settings-router-step-icon" />
                  : <AlertTriangle size={14} aria-hidden className="settings-router-step-icon" />}
                <div>
                  <strong>{finding.services.join(', ')}</strong>
                  <p>{finding.detail}</p>
                  <code>{finding.command}</code>
                </div>
                <span />
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

export default function RouterModule() {
  const presence = useLive<NetworkPresence>(PRESENCE_URL, true, 60_000);
  const [tab, setTab] = useState<RouterTab>('overview');
  // A configuração fica montada depois da primeira visita: trocar de aba não
  // pode deitar fora um formulário por gravar.
  const [configVisited, setConfigVisited] = useState(false);
  const tabListRef = useRef<HTMLElement>(null);
  // Fora da rede de gestão o registo ao vivo não tem o que mostrar: abre no que está guardado.
  const [pickedLogView, setLogView] = useState<LogViewId | null>(null);
  const offNetwork = presence.data?.state === 'offsite' || presence.data?.state === 'foreign';
  const logView = pickedLogView ?? (offNetwork ? 'stored' : 'live');

  const overview = useLive<Live<RouterOverview>>(`${ROUTER_API}/overview`, tab === 'overview');
  const sessions = useLive<Live<{ sessions: RouterSession[] }>>(`${ROUTER_API}/sessions`, tab === 'sessions');
  const interfaces = useLive<Live<{ interfaces: RouterInterface[] }>>(`${ROUTER_API}/interfaces`, tab === 'interfaces');
  const profiles = useLive<Live<{ profiles: RouterProfileOption[] }>>(`${ROUTER_API}/profiles`, tab === 'profiles');
  const log = useLive<Live<RouterLog>>(`${ROUTER_API}/log`, tab === 'log');
  const consumption = useLive<ClientUsageRow[]>(`${ROUTER_API}/clients/usage`, tab === 'consumption', 60_000);
  const plans = useLive<PlanRow[]>('http://127.0.0.1:3001/api/plans', tab === 'profiles');

  const backups = useLive<ConfigSnapshots>(`${ROUTER_API}/config/snapshots`, tab === 'backups', 60_000);
  const current = { overview, sessions, interfaces, profiles, consumption, backups, log, config: null }[tab];

  const selectTab = useCallback((next: RouterTab, moveFocus = false) => {
    if (next === 'config') setConfigVisited(true);
    setTab(next);
    if (moveFocus) queueMicrotask(() => tabListRef.current?.querySelector<HTMLButtonElement>(`#router-tab-${next}`)?.focus());
  }, []);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    selectTab(TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id, true);
  }

  const openConfig = () => selectTab('config');
  const head = overview.data?.available ? overview.data : null;

  return (
    <section className="module-panel router-module">
      <div className="module-header">
        <div>
          <p className="eyebrow">Rede</p>
          <div className="router-title">
            <h2>Router de gestão do ISP</h2>
            {head && <Badge tone={head.dryRun ? 'info' : 'success'}>{head.dryRun ? 'Em ensaio' : 'A controlar'}</Badge>}
          </div>
          <p className="router-subtitle">
            {head
              ? [head.system.identity, head.host, head.system.boardName, head.system.version && `RouterOS ${head.system.version}`].filter(Boolean).join(' · ')
              : 'O MikroTik da operadora, à cabeça da rede: sessões, perfis, interfaces, registo e a ligação ao ISPM.'}
          </p>
        </div>
        <ModuleHeaderActions
          ariaLabel="Ações do router"
          secondary={current ? (
            <SyncStatus
              syncing={current.syncing}
              syncedAt={current.syncedAt}
              error={current.error}
              onSync={() => { current.reload(); if (tab === 'profiles') plans.reload(); }}
            />
          ) : undefined}
        />
      </div>

      <nav ref={tabListRef} className="segmented-tabs" role="tablist" aria-label="Router de gestão do ISP">
        {TABS.map((item) => {
          const Icon = item.icon;
          const selected = tab === item.id;
          return (
            <Button
              key={item.id}
              id={`router-tab-${item.id}`}
              variant="ghost"
              role="tab"
              aria-selected={selected}
              aria-controls={`router-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              className={`segmented-tab${selected ? ' is-active' : ''}`}
              onClick={() => selectTab(item.id)}
              onKeyDown={handleTabKeyDown}
            >
              <Icon size={14} aria-hidden />
              <span>{item.label}</span>
            </Button>
          );
        })}
      </nav>

      <div id={tab === 'config' ? undefined : `router-panel-${tab}`} role="tabpanel" aria-labelledby={`router-tab-${tab}`} hidden={tab === 'config'}>
        {tab === 'overview' && (
          <LiveGate live={overview} onRetry={overview.reload} onConfigure={openConfig} presence={presence.data}>
            {(data) => <Overview data={data} onOpen={selectTab} />}
          </LiveGate>
        )}
        {tab === 'sessions' && (
          <LiveGate live={sessions} onRetry={sessions.reload} onConfigure={openConfig} presence={presence.data}>
            {(data) => <SessionsTable sessions={data.sessions} onChanged={sessions.reload} />}
          </LiveGate>
        )}
        {tab === 'profiles' && (
          <LiveGate live={profiles} onRetry={profiles.reload} onConfigure={openConfig} presence={presence.data}>
            {(data) => <ProfilesTable profiles={profileRows(data.profiles, plans.data ?? [])} />}
          </LiveGate>
        )}
        {tab === 'interfaces' && (
          <LiveGate live={interfaces} onRetry={interfaces.reload} onConfigure={openConfig} presence={presence.data}>
            {(data) => <InterfacesTable interfaces={data.interfaces} />}
          </LiveGate>
        )}
        {tab === 'log' && (
          <>
            <nav className="segmented-tabs router-log-views" role="tablist" aria-label="Vistas do registo">
              {LOG_VIEWS.map((item) => (
                <Button key={item.id} variant="ghost" role="tab" aria-selected={logView === item.id}
                  className={`segmented-tab${logView === item.id ? ' is-active' : ''}`} onClick={() => setLogView(item.id)}>
                  {item.label}
                </Button>
              ))}
            </nav>
            {logView === 'stored' ? <StoredLog /> : (
              <LiveGate live={log} onRetry={log.reload} onConfigure={openConfig} presence={presence.data}>
                {(data) => <LogView log={data} />}
              </LiveGate>
            )}
          </>
        )}
        {tab === 'backups' && (
          backups.error && !backups.data ? <ErrorRetry message={backups.error} onRetry={backups.reload} />
            : backups.data ? <ConfigBackups data={backups.data} onChanged={backups.reload} /> : <SkeletonList rows={5} />
        )}
        {tab === 'consumption' && (
          consumption.error && !consumption.data ? <ErrorRetry message={consumption.error} onRetry={consumption.reload} />
            : consumption.data ? <ClientUsage rows={consumption.data} onInstalled={consumption.reload} /> : <SkeletonList rows={5} />
        )}
      </div>

      {configVisited && (
        <div id="router-panel-config" role="tabpanel" aria-labelledby="router-tab-config" hidden={tab !== 'config'}>
          <SettingsModule scope="router" />
        </div>
      )}
    </section>
  );
}
