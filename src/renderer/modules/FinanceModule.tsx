import { Receipt, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components';
import { ExpensesModule } from './ExpensesModule';
import { InvestmentsModule } from './InvestmentsModule';
import { ProfitModule } from './ProfitModule';
import './FinanceModule.css';

type FinanceTab = 'lucro' | 'investimentos' | 'despesas';

const TABS: { id: FinanceTab; label: string; icon: typeof TrendingUp }[] = [
  { id: 'lucro', label: 'Lucro', icon: TrendingUp },
  { id: 'investimentos', label: 'Investimentos', icon: Wallet },
  { id: 'despesas', label: 'Despesas', icon: Receipt }
];

/**
 * Financeiro shell: groups Lucro (ProfitModule), Investimentos (InvestmentsModule) and
 * Despesas (ExpensesModule) under one sidebar entry with segmented sub-tabs. Each child keeps
 * its own toolbar/header; this shell only owns the page label + tab switching.
 */
export function FinanceModule() {
  const [tab, setTab] = useState<FinanceTab>('lucro');

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

      {tab === 'lucro' && <ProfitModule />}
      {tab === 'investimentos' && <InvestmentsModule />}
      {tab === 'despesas' && <ExpensesModule />}
    </div>
  );
}
