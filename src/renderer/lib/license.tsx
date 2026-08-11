/**
 * Estado de licenciamento no renderer.
 *
 * Um só provider partilhado pelo aviso no topo da aplicação e pelo painel em
 * Configurações — ativar a licença num sítio tem de apagar o aviso no outro,
 * e duas leituras independentes ficariam dessincronizadas.
 *
 * Nota de desenho: isto NÃO tranca a interface. Uma licença caducada deixa a
 * aplicação inteira acessível para consulta e exportação; as escritas é que
 * são recusadas pelo backend com 402. O papel do renderer é explicar porquê e
 * dar o caminho para resolver.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { authFetch } from './auth';

const API_BASE = 'http://127.0.0.1:3001';

export type LicenseState = 'trial' | 'active' | 'grace' | 'readonly' | 'invalid';

export type LicenseSummary = {
  id: string;
  customer: string;
  kind: 'subscricao' | 'perpetua';
  bind: 'machine' | 'none';
  issuedAt: string;
  expiresAt: string | null;
  maintenanceUntil: string | null;
  graceDays: number;
  entitlements: string[];
};

export type LicenseInfo = {
  state: LicenseState;
  canWrite: boolean;
  updatesAllowed: boolean;
  daysRemaining: number | null;
  reason: string;
  enabled: boolean;
  fingerprint: string;
  license: LicenseSummary | null;
};

type LicenseContextValue = {
  info: LicenseInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /**
   * `password` só é exigida quando já existe uma licença ativa a ser
   * substituída — o backend decide, e recusa com 400 se faltar.
   */
  activate: (token: string, password?: string) => Promise<void>;
  deactivate: (password: string) => Promise<void>;
};

const LicenseContext = createContext<LicenseContextValue | null>(null);

async function readError(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  return data.error || fallback;
}

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<LicenseInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch(`${API_BASE}/api/license`);
      if (!response.ok) throw new Error('estado indisponível');
      setInfo((await response.json()) as LicenseInfo);
    } catch {
      // Backend em arranque ou offline: sem estado, não se mostra aviso nenhum.
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activate = useCallback(async (token: string, password?: string) => {
    const response = await authFetch(`${API_BASE}/api/license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password ? { token, password } : { token })
    });
    if (!response.ok) {
      throw new Error(await readError(response, 'Não foi possível ativar a licença.'));
    }
    setInfo((await response.json()) as LicenseInfo);
  }, []);

  const deactivate = useCallback(async (password: string) => {
    const response = await authFetch(`${API_BASE}/api/license`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      throw new Error(await readError(response, 'Não foi possível remover a licença.'));
    }
    setInfo((await response.json()) as LicenseInfo);
  }, []);

  const value = useMemo(
    () => ({ info, loading, refresh, activate, deactivate }),
    [info, loading, refresh, activate, deactivate]
  );

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

export function useLicense(): LicenseContextValue {
  const context = useContext(LicenseContext);
  if (!context) throw new Error('useLicense fora de LicenseProvider');
  return context;
}

/**
 * O aviso só aparece quando há algo a fazer. Uma licença ativa — ou o
 * licenciamento desligado — não merece ocupar espaço no topo do ecrã todos os
 * dias.
 */
export function licenseNeedsAttention(info: LicenseInfo | null): boolean {
  if (!info || !info.enabled) return false;
  if (info.state === 'active') return !info.updatesAllowed;
  return true;
}

/** Quão insistente deve ser o aviso. */
export function licenseTone(info: LicenseInfo): 'danger' | 'warn' {
  return info.canWrite ? 'warn' : 'danger';
}
