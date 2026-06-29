import { Activity, AlertTriangle, Banknote, Boxes, Cable, ClipboardList, FileText, Gauge, Keyboard, LogOut, Plus, Search, Settings, ShieldCheck, TrendingUp, UserCog2, UsersRound, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGate, CommandPalette, ConfirmProvider, PageHeader, ShortcutsDialog, ThemeToggle, ToastProvider } from './components';
import type { CommandPaletteItem } from './components';
import { AuthProvider, authFetch, useAuth } from './lib/auth';
import type { UserRole } from './lib/auth';
import { installKeyboardNavigationIntent } from './lib/keyboardNavigation';
import { Dashboard } from './modules/Dashboard';
import { FinanceModule } from './modules/FinanceModule';
import { PaymentsModule } from './modules/PaymentsModule';
import { PlansModule } from './modules/PlansModule';
import { ServicesModule } from './modules/ServicesModule';
import { StockModule } from './modules/StockModule';
import { WorkOrdersModule } from './modules/WorkOrdersModule';
import { ReportsModule } from './modules/ReportsModule';
import { SettingsModule } from './modules/SettingsModule';
import { ClientsModule } from './modules/ClientsModule';
import { UsersModule } from './modules/UsersModule';
import { AuditModule } from './modules/AuditModule';
import type { DashboardSummary, HealthState, SectionId } from './types';

type SidebarItem = {
  id: SectionId;
  label: string;
  icon: typeof Gauge;
  roles?: UserRole[];
};

const sections: SidebarItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Gauge },
  { id: 'clients', label: 'Clientes', icon: UsersRound },
  { id: 'plans', label: 'Planos', icon: Wifi },
  { id: 'services', label: 'Servicos', icon: Cable },
  { id: 'payments', label: 'Pagamentos', icon: Banknote, roles: ['admin', 'operator'] },
  { id: 'finance', label: 'Financeiro', icon: TrendingUp, roles: ['admin', 'operator'] },
  { id: 'work-orders', label: 'OS tecnicas', icon: ClipboardList },
  { id: 'stock', label: 'Stock', icon: Boxes },
  { id: 'reports', label: 'Relatorios', icon: FileText, roles: ['admin', 'operator'] },
  { id: 'users', label: 'Utilizadores', icon: UserCog2, roles: ['admin'] },
  { id: 'audit', label: 'Auditoria', icon: ShieldCheck, roles: ['admin'] },
  { id: 'settings', label: 'Configuracoes', icon: Settings, roles: ['admin'] }
];

type SidebarCounter = { count: number; tone: 'danger' | 'info' | 'neutral' };

function counterFor(id: SectionId, summary: DashboardSummary | null): SidebarCounter | null {
  if (!summary) return null;
  switch (id) {
    case 'dashboard':
      return summary.workQueue.length > 0
        ? { count: summary.workQueue.length, tone: 'info' }
        : null;
    case 'payments':
      return summary.overduePayments > 0
        ? { count: summary.overduePayments, tone: 'danger' }
        : null;
    case 'stock':
      return summary.lowStockModels > 0
        ? { count: summary.lowStockModels, tone: 'info' }
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
            <AppShell />
          </AuthGate>
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const auth = useAuth();
  const visibleSections = sections.filter((item) => {
    if (!item.roles) return true;
    if (auth.isAuthBypassed) return true;
    return auth.user ? item.roles.includes(auth.user.role) : false;
  });

  const [health, setHealth] = useState<HealthState>('checking');
  const [section, setSection] = useState<SectionId>(() => visibleSections[0]?.id ?? 'dashboard');
  const [focusClientId, setFocusClientId] = useState<number | null>(null);
  const [focusServiceClientId, setFocusServiceClientId] = useState<number | null>(null);
  const [paymentsFocus, setPaymentsFocus] = useState<'overdue' | 'pending' | null>(null);
  const [stockLowFocus, setStockLowFocus] = useState(false);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => installKeyboardNavigationIntent(), []);

  useEffect(() => {
    if (!visibleSections.some((item) => item.id === section)) {
      setSection(visibleSections[0]?.id ?? 'dashboard');
    }
  }, [visibleSections, section]);

  useEffect(() => {
    const check = () => {
      fetch('http://127.0.0.1:3001/health')
        .then((response) => setHealth(response.ok ? 'online' : 'offline'))
        .catch(() => setHealth('offline'));
    };
    check();
    const id = setInterval(check, 15000); // reverifica a cada 15s; sem flicker (nunca volta a 'checking')
    return () => clearInterval(id);
  }, []);

  const refreshSummary = useCallback(() => {
    authFetch('http://127.0.0.1:3001/api/dashboard/summary')
      .then((response) => {
        if (!response.ok) throw new Error('summary unavailable');
        return response.json() as Promise<DashboardSummary>;
      })
      .then(setSummary)
      .catch(() => setSummary((previous) => previous));
  }, []);

  useEffect(() => {
    refreshSummary();
    const interval = window.setInterval(refreshSummary, PALETTE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refreshSummary]);

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
        action: () => setSection('payments')
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

  return (
    <>
      <a className="skip-link" href="#app-content">Saltar para conteudo</a>
      <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">I</span>
          <div>
            <strong>ISPM</strong>
            <span>Operacao ISP</span>
          </div>
        </div>

        <button
          type="button"
          className="palette-trigger"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={paletteOpen}
          title="Procurar (Ctrl+K)"
        >
          <Search size={14} aria-hidden />
          <span>Procurar</span>
          <kbd aria-hidden="true">Ctrl K</kbd>
        </button>

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
      </aside>

        <section className="content" id="app-content" tabIndex={-1}>
          <PageHeader
            eyebrow="Cabo Verde"
            title="Painel operacional"
            actions={
              <>
                <ThemeToggle />
                <div className={`status ${health}`} role="status" aria-live="polite">
                  <Activity size={16} aria-hidden />
                  <span>{health === 'checking' ? 'A verificar API' : health === 'online' ? 'API local online' : 'API offline'}</span>
                </div>
              </>
            }
          />

          {section === 'dashboard' && (
            <Dashboard
              onOpenClients={() => setSection('clients')}
              onOpenOverdue={() => { setPaymentsFocus('overdue'); setSection('payments'); }}
              onOpenPending={() => { setPaymentsFocus('pending'); setSection('payments'); }}
              onOpenLowStock={() => { setStockLowFocus(true); setSection('stock'); }}
              onOpenWorkOrders={() => setSection('work-orders')}
            />
          )}
          {section === 'clients' && (
            <ClientsModule
              focusClientId={focusClientId}
              onFocusHandled={() => setFocusClientId(null)}
              onOpenServicesForClient={(id) => {
                setFocusServiceClientId(id);
                setSection('services');
              }}
            />
          )}
          {section === 'plans' && <PlansModule />}
          {section === 'services' && (
            <ServicesModule
              focusClientId={focusServiceClientId}
              onFocusHandled={() => setFocusServiceClientId(null)}
            />
          )}
          {section === 'payments' && (
            <PaymentsModule focusStatus={paymentsFocus} onFocusHandled={() => setPaymentsFocus(null)} />
          )}
          {section === 'finance' && <FinanceModule />}
          {section === 'work-orders' && <WorkOrdersModule />}
          {section === 'stock' && (
            <StockModule focusLowStock={stockLowFocus} onFocusHandled={() => setStockLowFocus(false)} />
          )}
          {section === 'reports' && (
            <ReportsModule onOpenClient={(id) => { setFocusClientId(id); setSection('clients'); }} />
          )}
          {section === 'users' && <UsersModule />}
          {section === 'audit' && <AuditModule />}
          {section === 'settings' && <SettingsModule />}
        </section>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          items={paletteItems}
        />

        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </main>
    </>
  );
}
