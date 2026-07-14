import { Banknote, Receipt, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components';
import { ExpensesModule } from './ExpensesModule';
import { InvestmentsModule } from './InvestmentsModule';
import { PaymentsModule } from './PaymentsModule';
import { ProfitModule } from './ProfitModule';
import './FinanceModule.css';

type FinanceTab = 'pagamentos' | 'lucro' | 'investimentos' | 'despesas';

const TABS: { id: FinanceTab; label: string; icon: typeof TrendingUp }[] = [
  { id: 'pagamentos', label: 'Pagamentos', icon: Banknote },
  { id: 'lucro', label: 'Lucro', icon: TrendingUp },
  { id: 'investimentos', label: 'Investimentos', icon: Wallet },
  { id: 'despesas', label: 'Despesas', icon: Receipt }
];

/**
 * Financeiro shell: groups Pagamentos (PaymentsModule), Lucro (ProfitModule), Investimentos
 * (InvestmentsModule) and Despesas (ExpensesModule) under one sidebar entry with segmented
 * sub-tabs. Each child keeps its own toolbar/header; this shell only owns the page label + tab
 * switching. Pagamentos is the landing tab; the dashboard's overdue/pending deep-link flows
 * through `paymentsFocus`, consumed by PaymentsModule on mount.
 */
export function FinanceModule({
  paymentsFocus,
  paymentsMonth,
  onPaymentsFocusHandled
}: {
  paymentsFocus?: 'overdue' | 'pending' | null;
  paymentsMonth?: string | null;
  onPaymentsFocusHandled?: () => void;
} = {}) {
  const [tab, setTab] = useState<FinanceTab>('pagamentos');

  return (
    <div className="finance-shell">
      <div className="finance-tabs-row">
        <p className="eyebrow">Financeiro</p>
        <nav className="segmented-tabs" role="tablist" aria-label="Área financeira">
          {TABS.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              role="tab"
              aria-selected={tab === id}
              className={`segmented-tab${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              <Icon size={14} aria-hidden />
              <span>{label}</span>
            </Button>
          ))}
        </nav>
      </div>

      {tab === 'pagamentos' && (
        <PaymentsModule focusStatus={paymentsFocus} focusMonth={paymentsMonth} onFocusHandled={onPaymentsFocusHandled} />
      )}
      {tab === 'lucro' && <ProfitModule />}
      {tab === 'investimentos' && <InvestmentsModule />}
      {tab === 'despesas' && <ExpensesModule />}
    </div>
  );
}
