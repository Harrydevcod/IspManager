import { apiUrl } from './lib/api';
import { apiFetch } from './lib/apiFetch';
import { Activity, AlertTriangle, Boxes, Cable, ClipboardList, FileText, Gauge, Keyboard, Landmark, LifeBuoy, LogOut, Network, PanelLeftClose, PanelLeftOpen, Plus, Router, Search, Settings, ShieldCheck, TrendingUp, UserCog2, UsersRound, Wifi } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import { AuthGate, CommandPalette, ConfirmProvider, LicenseBanner, Message, NotificationBell, NotificationsProvider, ReleaseNotesDialog, ShortcutsDialog, ThemeOnboarding, ThemeToggle, ToastProvider, UpdateStatus, VaultBanner } from './components';
import type { NotificationBellData, NotificationFeed } from './components';
import type { CommandPaletteItem } from './components';
import { AuthProvider, authFetch, useAuth } from './lib/auth';
import { PRESENCE_URL, presenceMessage, type NetworkPresence } from './lib/networkPresence';
import { useLive } from './modules/router/useLive';
import { LicenseProvider } from './lib/license';
import type { UserRole } from './lib/auth';
import { installKeyboardNavigationIntent } from './lib/keyboardNavigation';
import { readSidebarCollapsed, writeSidebarCollapsed } from './lib/sidebar';
import { watchSystemTheme } from './lib/theme';
import { Dashboard } from './modules/Dashboard';
import { useUpcomingSuspensionsNotice } from './modules/finance/UpcomingSuspensionsCard';
import { FinanceModule, type FinanceTab } from './modules/FinanceModule';
import { TreasuryModule } from './modules/treasury/TreasuryModule';
import { PlansModule } from './modules/PlansModule';
import { ServicesModule } from './modules/ServicesModule';
import { StockModule } from './modules/StockModule';
import { WorkOrdersModule } from './modules/WorkOrdersModule';
import { SupportModule } from './modules/support/SupportModule';
import { ReportsModule } from './modules/ReportsModule';
import { SettingsModule, type SettingsTab } from './modules/SettingsModule';
import RouterModule from './modules/router/RouterModule';
import { ClientsModule } from './modules/ClientsModule';
import { DocumentsModule } from './modules/documents/DocumentsModule';
import { UsersModule } from './modules/UsersModule';
import { AuditModule } from './modules/AuditModule';
import type { Client, DashboardSummary, HealthState, SectionId } from './types';

const TopologyModule = lazy(() => import('./modules/topology/TopologyModule'));

type SidebarItem = {
  id: SectionId;
  label: string;
  icon: typeof Gauge;
  roles?: UserRole[];
};

const sections: SidebarItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Gauge },
  { id: 'clients', label: 'Clientes', icon: UsersRound },
  { id: 'documents', label: 'Documentos', icon: FileText, roles: ['admin', 'operator'] },
  { id: 'plans', label: 'Planos', icon: Wifi },
  { id: 'services', label: 'Serviços', icon: Cable },
  { id: 'topology', label: 'Topologia', icon: Network },
  { id: 'router', label: 'Router de gestão', icon: Router, roles: ['admin'] },
  { id: 'finance', label: 'Financeiro', icon: TrendingUp, roles: ['admin', 'operator'] },
  { id: 'treasury', label: 'Tesouraria', icon: Landmark, roles: ['admin', 'operator'] },
  { id: 'support', label: 'Assistência', icon: LifeBuoy },
  { id: 'work-orders', label: 'OS técnicas', icon: ClipboardList },
  { id: 'stock', label: 'Stock', icon: Boxes },
  { id: 'reports', label: 'Relatórios', icon: FileText, roles: ['admin', 'operator'] },
  { id: 'users', label: 'Utilizadores', icon: UserCog2, roles: ['admin'] },
  { id: 'audit', label: 'Auditoria', icon: ShieldCheck, roles: ['admin'] },
  { id: 'settings', label: 'Configurações', icon: Settings, roles: ['admin'] }
];

function sectionVisible(item: SidebarItem, role: UserRole | null, bypassed: boolean): boolean {
  if (!item.roles || bypassed) return true;
  return role ? item.roles.includes(role) : false;
}

export function sectionIdsForRole(role: UserRole): SectionId[] {
  return sections.filter((item) => sectionVisible(item, role, false)).map((item) => item.id);
}

type SidebarCounter = { count: number; tone: 'danger' | 'info' | 'neutral' };

function counterFor(id: SectionId, summary: DashboardSummary | null): SidebarCounter | null {
  if (!summary) return null;
  switch (id) {
    case 'dashboard':
      return summary.workQueue.length > 0
        ? { count: summary.workQueue.length, tone: 'info' }
        : null;
    case 'finance':
      return summary.overduePayments > 0
        ? { count: summary.overduePayments, tone: 'danger' }
        : null;
    case 'stock':
      return summary.lowStockModels > 0
        ? { count: summary.lowStockModels, tone: 'info' }
        : null;
    case 'support':
      return summary.openTickets > 0
        ? { count: summary.openTickets, tone: 'danger' }
        : null;
    case 'work-orders':
      return summary.openWorkOrders > 0
        ? { count: summary.openWorkOrders, tone: 'info' }
        : null;
    default:
      return null;
  }
}

const PALETTE_REFRESH_MS = 60_000;

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AuthGate>
            {/* Dentro do AuthGate: ativar licença é uma ação de administrador,
                logo precisa de sessão. O login em si nunca é bloqueado. */}
            <LicenseProvider>
              <AppShell />
            </LicenseProvider>
          </AuthGate>
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const auth = useAuth();
  const presence = useLive<NetworkPresence>(PRESENCE_URL, auth.user?.role === 'admin', 60_000);
  const visibleSections = sections.filter((item) => (
    sectionVisible(item, auth.user?.role ?? null, auth.isAuthBypassed)
  ));

  const [health, setHealth] = useState<HealthState>('checking');
  const [section, setSection] = useState<SectionId>(() => visibleSections[0]?.id ?? 'dashboard');
  const [focusClientId, setFocusClientId] = useState<number | null>(null);
  const [proposalClient, setProposalClient] = useState<Client | null>(null);
  const [focusServiceClientId, setFocusServiceClientId] = useState<number | null>(null);
  const [focusServiceId, setFocusServiceId] = useState<number | null>(null);
  /**
   * Qual das atribuições do serviço é que se vai substituir.
   *
   * Anda agarrado ao `focusServiceId` — sozinho não diz nada, porque a lista de
   * equipamento só existe depois de o serviço estar aberto.
   */
  const [focusAssignmentId, setFocusAssignmentId] = useState<number | null>(null);
  const [paymentsFocus, setPaymentsFocus] = useState<'overdue' | 'pending' | null>(null);
  // Separador do Financeiro pedido por um alerta, e o contador que o remonta
  // quando o mesmo alerta é clicado outra vez. Mesmo molde das Configurações.
  const [financeTab, setFinanceTab] = useState<FinanceTab | null>(null);
  const [financeRequest, setFinanceRequest] = useState(0);
  const [paymentFocusId, setPaymentFocusId] = useState<number | null>(null);
  const [paymentsMonth, setPaymentsMonth] = useState<string | null>(null);
  const [stockLowFocus, setStockLowFocus] = useState(false);
  const [stockCatalogFocus, setStockCatalogFocus] = useState<number | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [notifications, setNotifications] = useState<NotificationFeed | null>(null);
  // Separador das Configurações pedido de fora (o sino manda o alerta ao sítio que o trata).
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [releaseNotesVersion, setReleaseNotesVersion] = useState<string | null>(null);
  const [navCollapsed, setNavCollapsed] = useState(readSidebarCollapsed);
  // A legenda do menu recolhido vive fora da sidebar: ela tem overflow e cortava um rótulo lá dentro.
  const [railTip, setRailTip] = useState<{ label: string; top: number; left: number } | null>(null);
  useEffect(() => { if (!navCollapsed) setRailTip(null); }, [navCollapsed]);
  const railTipProps = (label: string) => navCollapsed ? {
    onPointerEnter: (event: SyntheticEvent<HTMLElement>) => showRailTip(event, label),
    onFocus: (event: SyntheticEvent<HTMLElement>) => showRailTip(event, label),
    onPointerLeave: () => setRailTip(null),
    onBlur: () => setRailTip(null)
  } : {};
  function showRailTip(event: SyntheticEvent<HTMLElement>, label: string) {
    const button = event.currentTarget.getBoundingClientRect();
    const sidebar = event.currentTarget.closest('.sidebar')?.getBoundingClientRect();
    setRailTip({ label, top: button.top + button.height / 2, left: (sidebar?.right ?? button.right) + 8 });
  }
  // Muda a cada pedido do aviso do cofre: remonta as Configurações já no separador Cofre.
  const [vaultOpenRequest, setVaultOpenRequest] = useState(0);
  // O cartão da rede no painel abre a Topologia já nos Incidentes; sair dela esquece o pedido.
  const [topologyTab, setTopologyTab] = useState<'incidents' | undefined>(undefined);
  useEffect(() => { if (section !== 'topology') setTopologyTab(undefined); }, [section]);

  // Suspensões a chegar: notificação do Windows uma vez por dia, para quem cobra.
  const openDashboard = useCallback(() => setSection('dashboard'), []);
  useUpcomingSuspensionsNotice(visibleSections.some((item) => item.id === 'finance'), openDashboard);

  useEffect(() => writeSidebarCollapsed(navCollapsed), [navCollapsed]);
  useEffect(() => installKeyboardNavigationIntent(), []);
  useEffect(() => watchSystemTheme(), []);
  // Menu Sobre → "Novidades desta versão" (IPC do processo main).
  useEffect(() => window.ispm?.onShowReleaseNotes?.(setReleaseNotesVersion), []);

  useEffect(() => {
    if (!visibleSections.some((item) => item.id === section)) {
      setSection(visibleSections[0]?.id ?? 'dashboard');
    }
  }, [visibleSections, section]);

  useEffect(() => {
    const check = () => {
      apiFetch(apiUrl('/health'))
        .then((response) => setHealth(response.ok ? 'online' : 'offline'))
        .catch(() => setHealth('offline'));
    };
    check();
    const id = setInterval(check, 15000); // reverifica a cada 15s; sem flicker (nunca volta a 'checking')
    return () => clearInterval(id);
  }, []);

  const refreshSummary = useCallback(() => {
    authFetch(apiUrl('/api/dashboard/summary'))
      .then((response) => {
        if (!response.ok) throw new Error('summary unavailable');
        return response.json() as Promise<DashboardSummary>;
      })
      .then(setSummary)
      .catch(() => setSummary((previous) => previous));
  }, []);

  const refreshNotifications = useCallback(() => {
    authFetch(apiUrl('/api/notifications'))
      .then((response) => {
        if (!response.ok) throw new Error('notifications unavailable');
        return response.json() as Promise<NotificationFeed>;
      })
      .then(setNotifications)
      .catch(() => setNotifications((previous) => previous));
  }, []);

  // Um só relógio para o resumo e para o sino: dois intervalos de 60 s eram o
  // mesmo trabalho a dobrar.
  useEffect(() => {
    const tick = () => { refreshSummary(); refreshNotifications(); };
    tick();
    const interval = window.setInterval(tick, PALETTE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refreshSummary, refreshNotifications]);

  const notificationPost = useCallback((path: string) => {
    void authFetch(apiUrl(`/api/notifications${path}`), { method: 'POST' })
      .catch(() => undefined);
  }, []);

  const openNotifications = useCallback(() => {
    notificationPost('/seen');
    setNotifications((feed) => (feed ? { ...feed, unseen: 0 } : feed));
  }, [notificationPost]);

  const readNotification = useCallback((id: number) => {
    notificationPost(`/${id}/read`);
    setNotifications((feed) => (feed
      ? { ...feed, history: feed.history.map((entry) => (entry.id === id ? { ...entry, read: true } : entry)) }
      : feed));
  }, [notificationPost]);

  const readAllNotifications = useCallback(() => {
    notificationPost('/read-all');
    setNotifications((feed) => (feed
      ? { ...feed, unseen: 0, history: feed.history.map((entry) => ({ ...entry, read: true })) }
      : feed));
  }, [notificationPost]);

  /** O alerta leva ao sítio que o trata: a secção, e o separador ou filtro lá dentro. */
  const openNotificationTarget = useCallback((target: string, focus: string | null) => {
    if (target === 'finance' && (focus === 'overdue' || focus === 'pending')) setPaymentsFocus(focus);
    if (target === 'finance' && focus === 'behaviour') {
      setFinanceTab('comportamento');
      setFinanceRequest((request) => request + 1);
    }
    if (target === 'topology' && focus === 'incidents') setTopologyTab('incidents');
    if (target === 'stock') setStockLowFocus(focus === 'low');
    if (target === 'settings' && focus) {
      setSettingsTab(focus as SettingsTab);
      setSettingsRequest((request) => request + 1);
    }
    setSection(target as SectionId);
  }, []);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Ctrl/Cmd+B recolhe o menu lateral — a tecla que VS Code, Linear e Notion usam.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setNavCollapsed((collapsed) => !collapsed);
        return;
      }
      // "?" abre o cheat-sheet de atalhos (não enquanto se escreve num campo).
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const paletteItems = useMemo<CommandPaletteItem[]>(() => {
    const nav: CommandPaletteItem[] = visibleSections.map((item) => {
      const Icon = item.icon;
      return {
        id: `goto-${item.id}`,
        label: `Ir para ${item.label}`,
        group: 'Navegacao',
        keywords: ['ir', 'abrir', item.label.toLowerCase()],
        icon: <Icon size={14} aria-hidden />,
        action: () => setSection(item.id)
      };
    });
    const alerts: CommandPaletteItem[] = [];
    if (summary && summary.overduePayments > 0) {
      alerts.push({
        id: 'alert-overdue',
        label: 'Ver pagamentos em atraso',
        hint: `${summary.overduePayments} em atraso`,
        group: 'Alertas',
        keywords: ['atraso', 'overdue', 'cobranca'],
        icon: <AlertTriangle size={14} />,
        action: () => { setPaymentsFocus('overdue'); setSection('finance'); }
      });
    }
    if (summary && summary.lowStockModels > 0) {
      alerts.push({
        id: 'alert-stock',
        label: 'Verificar stock baixo',
        hint: `${summary.lowStockModels} modelos`,
        group: 'Alertas',
        keywords: ['stock', 'baixo', 'equipamento'],
        icon: <AlertTriangle size={14} />,
        action: () => setSection('stock')
      });
    }
    const quickActions: CommandPaletteItem[] = [
      {
        id: 'new-client',
        label: 'Novo cliente',
        group: 'Criar',
        keywords: ['cliente', 'criar', 'novo'],
        icon: <Plus size={14} />,
        action: () => setSection('clients')
      },
      {
        id: 'new-plan',
        label: 'Novo plano',
        group: 'Criar',
        keywords: ['plano', 'criar', 'novo'],
        icon: <Plus size={14} />,
        action: () => setSection('plans')
      },
      {
        id: 'new-service',
        label: 'Novo servico',
        group: 'Criar',
        keywords: ['servico', 'criar', 'novo'],
        icon: <Plus size={14} />,
        action: () => setSection('services')
      },
      {
        id: 'new-work-order',
        label: 'Nova OS tecnica',
        group: 'Criar',
        keywords: ['os', 'ordem', 'tecnico', 'manutencao', 'instalacao'],
        icon: <Plus size={14} />,
        action: () => setSection('work-orders')
      }
    ].filter((item) => {
      if (auth.isAuthBypassed) return true;
      if (auth.user?.role === 'technician') return item.id === 'new-work-order';
      return true;
    });
    const sessionActions: CommandPaletteItem[] = auth.user && !auth.isAuthBypassed
      ? [{
          id: 'logout',
          label: 'Terminar sessao',
          group: 'Sessao',
          keywords: ['logout', 'sair', 'sessao', 'terminar'],
          icon: <LogOut size={14} />,
          action: () => auth.logout()
        }]
      : [];
    const helpActions: CommandPaletteItem[] = [{
      id: 'show-shortcuts',
      label: 'Atalhos de teclado',
      hint: '?',
      group: 'Ajuda',
      keywords: ['atalhos', 'teclado', 'shortcuts', 'ajuda', 'help'],
      icon: <Keyboard size={14} />,
      action: () => setShortcutsOpen(true)
    }];
    return [...alerts, ...nav, ...quickActions, ...sessionActions, ...helpActions];
  }, [summary, visibleSections, auth]);

  const roleLabel: Record<UserRole, string> = {
    admin: 'Admin',
    operator: 'Operadora',
    technician: 'Tecnico'
  };

  const healthLabel = health === 'checking' ? 'A verificar API' : health === 'online' ? 'API local online' : 'API offline';

  // Os dados do sino num só sítio: a barra lateral e o Comando operacional
  // mostram o mesmo, sem ninguém os passar de mão em mão.
  const notificationBell = useMemo<NotificationBellData>(() => ({
    feed: notifications,
    onOpen: openNotifications,
    onNavigate: openNotificationTarget,
    onRead: readNotification,
    onReadAll: readAllNotifications
  }), [notifications, openNotifications, openNotificationTarget, readNotification, readAllNotifications]);

  return (
    <NotificationsProvider value={notificationBell}>
      <a className="skip-link" href="#app-content">Saltar para conteúdo</a>
      <main className="app-shell" data-nav={navCollapsed ? 'rail' : undefined}>
      <aside className="sidebar" onScroll={() => setRailTip(null)}>
        <div className="brand">
          <img className="brand-mark" src="./favicon.png" alt="" />
          <div>
            <strong>ISPM</strong>
            <span>Operação ISP</span>
          </div>
          <button
            type="button"
            className="brand-toggle"
            onClick={() => setNavCollapsed((collapsed) => !collapsed)}
            aria-expanded={!navCollapsed}
            aria-label={navCollapsed ? 'Expandir menu' : 'Recolher menu'}
            title={navCollapsed ? undefined : 'Recolher menu (Ctrl+B)'}
            {...railTipProps('Expandir menu · Ctrl B')}
          >
            {navCollapsed
              ? <PanelLeftOpen size={16} aria-hidden />
              : <PanelLeftClose size={16} aria-hidden />}
          </button>
        </div>

        <button
          type="button"
          className="palette-trigger"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={paletteOpen}
          title={navCollapsed ? undefined : 'Procurar (Ctrl+K)'}
          {...railTipProps('Procurar · Ctrl K')}
        >
          <Search size={14} aria-hidden />
          <span>Procurar</span>
          <kbd aria-hidden="true">Ctrl K</kbd>
        </button>

        <NotificationBell {...notificationBell} collapsed={navCollapsed} tipProps={railTipProps} />

        <nav className="nav-list" aria-label="Principal">
          {visibleSections.map((item) => {
            const Icon = item.icon;
            const counter = counterFor(item.id, summary);
            const counterLabel = counter ? `, ${counter.count} alerta${counter.count === 1 ? '' : 's'}` : '';
            return (
              <button
                className={section === item.id ? 'active' : ''}
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                aria-current={section === item.id ? 'page' : undefined}
                aria-label={`${item.label}${counterLabel}`}
                {...railTipProps(counter ? `${item.label} · ${counter.count} alerta${counter.count === 1 ? '' : 's'}` : item.label)}
              >
                <Icon size={18} aria-hidden />
                <span className="nav-label">{item.label}</span>
                {counter && (
                  <span className={`nav-counter nav-counter-${counter.tone}`} aria-hidden="true">{counter.count}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <UpdateStatus />
          <div className="sidebar-system">
            <div className={`status ${health}`} role="status" aria-live="polite" title={healthLabel}>
              <Activity size={14} aria-hidden />
              <span>{healthLabel}</span>
            </div>
            <ThemeToggle />
          </div>

          {auth.user && !auth.isAuthBypassed && (
            <div className="sidebar-user">
              <div className="sidebar-user-identity">
                <span className="sidebar-user-mark">{auth.user.fullName.charAt(0).toUpperCase()}</span>
                <div>
                  <p className="sidebar-user-name">{auth.user.fullName}</p>
                  <p className="sidebar-user-role">{roleLabel[auth.user.role]} &middot; @{auth.user.username}</p>
                </div>
              </div>
              <button
                type="button"
                className="sidebar-user-logout"
                onClick={() => auth.logout()}
                title="Terminar sessao"
                aria-label="Terminar sessao"
              >
                <LogOut size={14} aria-hidden />
              </button>
            </div>
          )}
        </div>
      </aside>
      {railTip && (
        // Só visual: o aria-label do botão já diz o mesmo ao leitor de ecrã.
        <div className="nav-rail-tip" aria-hidden="true" style={{ top: railTip.top, left: railTip.left }}>{railTip.label}</div>
      )}

        <section className="content" id="app-content" tabIndex={-1}>
          {presence.data && (presence.data.state === 'offsite' || presence.data.state === 'foreign') && (
            <Message tone="neutral">{presenceMessage(presence.data)}</Message>
          )}
          <LicenseBanner />
          <VaultBanner onOpen={() => { setVaultOpenRequest((request) => request + 1); setSection('settings'); }} />
          <h1 className="sr-only">ISPM</h1>

          {section === 'dashboard' && (
            <Dashboard
              onOpenClients={() => setSection('clients')}
              onOpenOverdue={() => { setPaymentsFocus('overdue'); setSection('finance'); }}
              onOpenPending={() => { setPaymentsFocus('pending'); setSection('finance'); }}
              onOpenLowStock={() => { setStockLowFocus(true); setSection('stock'); }}
              onOpenWorkOrders={() => setSection('work-orders')}
              onOpenMonth={(month) => { setPaymentsMonth(month); setSection('finance'); }}
              onOpenNetwork={() => { setTopologyTab('incidents'); setSection('topology'); }}
              onOpenPayment={(id) => { setPaymentFocusId(id); setSection('finance'); }}
            />
          )}
          {section === 'clients' && (
            <ClientsModule
              focusClientId={focusClientId}
              onFocusHandled={() => setFocusClientId(null)}
              onCreateProposal={(client) => { setProposalClient(client); setSection('documents'); }}
              onOpenServicesForClient={(id) => {
                setFocusServiceClientId(id);
                setSection('services');
              }}
            />
          )}
          {section === 'plans' && <PlansModule />}
          {section === 'documents' && <DocumentsModule initialClient={proposalClient} onInitialClientHandled={() => setProposalClient(null)} onOpenPayment={id => {setPaymentFocusId(id);setSection('finance');}} />}
          {section === 'services' && (
            <ServicesModule
              focusClientId={focusServiceClientId}
              focusServiceId={focusServiceId}
              focusAssignmentId={focusAssignmentId}
              onFocusHandled={() => {
                setFocusServiceClientId(null);
                setFocusServiceId(null);
                setFocusAssignmentId(null);
              }}
            />
          )}
          {section === 'topology' && (
            <Suspense fallback={<TopologyModuleFallback />}>
              <TopologyModule
                initialTab={topologyTab}
                onOpenClient={(id) => {
                  setFocusClientId(id);
                  setSection('clients');
                }}
                onOpenService={(clientId, serviceId, assignmentId) => {
                  setFocusServiceClientId(clientId);
                  setFocusServiceId(serviceId);
                  setFocusAssignmentId(assignmentId ?? null);
                  setSection('services');
                }}
                onOpenStock={(catalogId) => {
                  setStockCatalogFocus(catalogId);
                  setSection('stock');
                }}
              />
            </Suspense>
          )}
          {section === 'router' && <RouterModule />}
          {section === 'finance' && (
            <FinanceModule
              key={financeRequest}
              initialTab={financeTab ?? undefined}
              paymentFocusId={paymentFocusId}
              onPaymentFocusHandled={() => setPaymentFocusId(null)}
              paymentsFocus={paymentsFocus}
              paymentsMonth={paymentsMonth}
              onPaymentsFocusHandled={() => { setPaymentsFocus(null); setPaymentsMonth(null); }}
              onOpenClient={(id) => { setFocusClientId(id); setSection('clients'); }}
            />
          )}
          {section === 'treasury' && <TreasuryModule />}
          {section === 'support' && <SupportModule />}
          {section === 'work-orders' && <WorkOrdersModule />}
          {section === 'stock' && (
            <StockModule
              focusLowStock={stockLowFocus}
              focusCatalogId={stockCatalogFocus}
              onFocusHandled={() => setStockLowFocus(false)}
              onCatalogFocusHandled={() => setStockCatalogFocus(null)}
            />
          )}
          {section === 'reports' && (
            <ReportsModule onOpenClient={(id) => { setFocusClientId(id); setSection('clients'); }} />
          )}
          {section === 'users' && <UsersModule />}
          {section === 'audit' && <AuditModule />}
          {section === 'settings' && (
            <SettingsModule
              key={`${vaultOpenRequest}-${settingsRequest}`}
              initialTab={vaultOpenRequest > 0 ? 'vault' : settingsTab ?? undefined}
            />
          )}
        </section>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          items={paletteItems}
        />

        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

        {releaseNotesVersion && (
          <ReleaseNotesDialog version={releaseNotesVersion} onClose={() => setReleaseNotesVersion(null)} />
        )}

        <ThemeOnboarding />
      </main>
    </NotificationsProvider>
  );
}

function TopologyModuleFallback() {
  return (
    <section className="module-panel" aria-label="A preparar topologia">
      <div className="module-header">
        <div>
          <p className="eyebrow">Infraestrutura</p>
          <h2>Topologia de rede</h2>
        </div>
      </div>
      <p className="module-message" role="status">A preparar o mapa de inventário…</p>
    </section>
  );
}
