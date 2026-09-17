import { useCallback, useEffect, useState } from 'react';
import { authFetch } from './auth';

export const TREASURY_API = 'http://127.0.0.1:3001/api/treasury';

export type TreasuryAccountKind = 'caixa' | 'banco';
export type MovementKind =
  | 'recebimento' | 'deposito' | 'transferencia' | 'despesa' | 'investimento' | 'ajuste' | 'estorno';

export type TreasuryAccount = {
  id: number;
  kind: TreasuryAccountKind;
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  holderName: string | null;
  reference: string | null;
  openingBalanceCve: number;
  openingDate: string;
  isDefaultCash: boolean;
  showOnDocuments: boolean;
  active: boolean;
  sortOrder: number;
  balanceCve: number;
  lastMovementDate: string | null;
};

export type TreasuryMovement = {
  id: number;
  accountId: number;
  accountName: string;
  accountKind: TreasuryAccountKind;
  direction: 'in' | 'out';
  amountCve: number;
  movementDate: string;
  kind: MovementKind;
  receiptId: number | null;
  expenseId: number | null;
  investmentId: number | null;
  transferGroup: string | null;
  reversalOfId: number | null;
  reversedById: number | null;
  reference: string | null;
  description: string;
  createdByName: string | null;
  createdAt: string;
  balanceAfterCve?: number;
};

export type TreasurySummary = {
  month: string;
  totalCve: number;
  cashCve: number;
  bankCve: number;
  monthInCve: number;
  monthOutCve: number;
  accounts: TreasuryAccount[];
};

export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  recebimento: 'Recebimento',
  deposito: 'Depósito',
  transferencia: 'Transferência',
  despesa: 'Despesa',
  investimento: 'Investimento',
  ajuste: 'Ajuste',
  estorno: 'Estorno'
};

export const ACCOUNT_KIND_LABEL: Record<TreasuryAccountKind, string> = {
  caixa: 'Caixa',
  banco: 'Banco'
};

/** Para onde pode ir o dinheiro, conforme o que o operador está a registar. */
export type AccountPurpose = 'numerario' | 'transferencia' | 'outro' | 'saida';

export function accountsFor(purpose: AccountPurpose, accounts: TreasuryAccount[]): TreasuryAccount[] {
  const active = accounts.filter((account) => account.active);
  if (purpose === 'numerario') return active.filter((account) => account.kind === 'caixa');
  if (purpose === 'transferencia') return active.filter((account) => account.kind === 'banco');
  return active;
}

export function accountLabel(account: TreasuryAccount): string {
  if (account.kind === 'caixa') return account.isDefaultCash ? `${account.name} (predefinida)` : account.name;
  const number = account.accountNumber ? ` · ${account.accountNumber}` : '';
  return `${account.name}${number}`;
}

/** Contas da tesouraria (todas, ativas e desativadas); `reload` volta a pedir. */
export function useTreasuryAccounts() {
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await authFetch(`${TREASURY_API}/accounts`);
      if (response.ok) setAccounts(await response.json() as TreasuryAccount[]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return { accounts, loaded, reload };
}
