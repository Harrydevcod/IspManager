import { AlertTriangle, Banknote, Receipt, TrendingUp, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { TabList } from '../components';
import { ExpensesModule } from './ExpensesModule';
import { InvestmentsModule } from './InvestmentsModule';
import { PaymentsModule } from './PaymentsModule';
import { ProfitModule } from './ProfitModule';
import { ReceivablesModule } from './ReceivablesModule';
import { ClientFinanceDialog } from './finance/ClientFinanceDialog';
import './FinanceModule.css';

type FinanceTab = 'pagamentos' | 'pendentes' | 'lucro' | 'investimentos' | 'despesas';

const TABS = [
  { id: 'pagamentos', label: 'Pagamentos', icon: Banknote },
  { id: 'pendentes', label: 'Pendentes', icon: AlertTriangle },
  { id: 'lucro', label: 'Lucro', icon: TrendingUp },
  { id: 'investimentos', label: 'Investimentos', icon: Wallet },
  { id: 'despesas', label: 'Despesas', icon: Receipt }
].map(({ id, label, icon: Icon }) => ({ id: id as FinanceTab, label: <><Icon size={14} aria-hidden /><span>{label}</span></> }));

/**
 * Financeiro shell: groups Pagamentos (PaymentsModule), Lucro (ProfitModule), Investimentos
 * (InvestmentsModule) and Despesas (ExpensesModule) under one sidebar entry with segmented
 * sub-tabs. Each child keeps its own toolbar/header; this shell only owns the page label + tab
 * switching. Pagamentos is the landing tab; the dashboard's overdue/pending deep-link flows
 * through `paymentsFocus`, consumed by PaymentsModule on mount.
 */
export function FinanceModule({
  paymentFocusId, onPaymentFocusHandled,
  paymentsFocus,
  paymentsMonth,
  onPaymentsFocusHandled,
  onOpenClient
}: {
  paymentFocusId?: number | null; onPaymentFocusHandled?: () => void;
  paymentsFocus?: 'overdue' | 'pending' | null;
  paymentsMonth?: string | null;
  onPaymentsFocusHandled?: () => void;
  onOpenClient?: (clientId: number) => void;
} = {}) {
  const [tab, setTab] = useState<FinanceTab>('pagamentos');
  const [financeClientId, setFinanceClientId] = useState<number | null>(null);
  // Fatura aberta a partir da ficha financeira; o foco vindo de fora (App) continua a valer.
  const [localPaymentFocus, setLocalPaymentFocus] = useState<number | null>(null);
  const focusPaymentId = localPaymentFocus ?? paymentFocusId;
  const handlePaymentFocus = useCallback(() => {
    setLocalPaymentFocus(null);
    onPaymentFocusHandled?.();
  }, [onPaymentFocusHandled]);
  // A focused document must open the billing workspace even if another tab was selected.
  useEffect(() => {if(focusPaymentId) setTab('pagamentos');},[focusPaymentId]);

  return (
    <div className="finance-shell">
      <div className="finance-tabs-row">
        <p className="eyebrow">Financeiro</p>
        <TabList segmented idPrefix="finance" label="Área financeira" tabs={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="tab-panel" role="tabpanel" id={`finance-panel-${tab}`} aria-labelledby={`finance-tab-${tab}`}>

      {tab === 'pagamentos' && (
        <PaymentsModule focusPaymentId={focusPaymentId} onPaymentFocusHandled={handlePaymentFocus} focusStatus={paymentsFocus} focusMonth={paymentsMonth} onFocusHandled={onPaymentsFocusHandled} onOpenClientFinance={setFinanceClientId} />
      )}
      {tab === 'pendentes' && <ReceivablesModule onOpenClient={setFinanceClientId} />}
      {tab === 'lucro' && <ProfitModule />}
      {tab === 'investimentos' && <InvestmentsModule />}
      {tab === 'despesas' && <ExpensesModule />}
      </div>

      {financeClientId !== null && (
        <ClientFinanceDialog
          key={financeClientId}
          clientId={financeClientId}
          onClose={() => setFinanceClientId(null)}
          onOpenInvoice={(paymentId) => { setFinanceClientId(null); setLocalPaymentFocus(paymentId); }}
          onOpenClient={onOpenClient ? (id) => { setFinanceClientId(null); onOpenClient(id); } : undefined}
        />
      )}
    </div>
  );
}
