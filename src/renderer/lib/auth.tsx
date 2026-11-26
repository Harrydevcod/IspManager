import { apiUrl } from './api';
import { apiFetch } from './apiFetch';
import { MOBILE_ORIGIN } from './mobileBootstrap';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type UserRole = 'admin' | 'operator' | 'technician';

export type CurrentUser = {
  id: number;
  username: string;
  fullName: string;
  role: UserRole;
};

type AuthStatus =
  | { kind: 'loading' }
  | { kind: 'setup-required' }
  | { kind: 'login-required'; lastError?: string }
  | { kind: 'authenticated'; user: CurrentUser; token: string };

type AuthContextValue = {
  status: AuthStatus;
  user: CurrentUser | null;
  token: string | null;
  isAuthBypassed: boolean;
  login: (username: string, password: string) => Promise<void>;
  setupAdmin: (username: string, password: string, fullName: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  hasRole: (...roles: UserRole[]) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const STORAGE_KEY = 'ispm:auth-token';
const API_BASE = apiUrl('');

function readStoredToken(): string | null {
  try {
    return (window.location.origin === MOBILE_ORIGIN ? sessionStorage : localStorage).getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    const storage = window.location.origin === MOBILE_ORIGIN ? sessionStorage : localStorage;
    if (token) storage.setItem(STORAGE_KEY, token);
    else storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore (private mode etc.)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>({ kind: 'loading' });
  const [isAuthBypassed, setIsAuthBypassed] = useState(false);

  const bootstrap = useCallback(async () => {
    try {
      const statusResp = await apiFetch(`${API_BASE}/api/auth/status`);
      if (!statusResp.ok) throw new Error('status unavailable');
      const statusBody = (await statusResp.json()) as { setupRequired: boolean; authBypassed: boolean };
      setIsAuthBypassed(statusBody.authBypassed);

      if (statusBody.authBypassed) {
        setStatus({
          kind: 'authenticated',
          user: { id: 0, username: 'system', fullName: 'System (auth desligado)', role: 'admin' },
          token: ''
        });
        return;
      }
      if (statusBody.setupRequired) {
        writeStoredToken(null);
        setStatus({ kind: 'setup-required' });
        return;
      }

      const token = readStoredToken();
      if (!token) {
        setStatus({ kind: 'login-required' });
        return;
      }

      const meResp = await apiFetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!meResp.ok) {
        writeStoredToken(null);
        setStatus({ kind: 'login-required' });
        return;
      }
      const meBody = (await meResp.json()) as { user: CurrentUser };
      setStatus({ kind: 'authenticated', user: meBody.user, token });
    } catch {
      // Backend down — show login, user can retry
      setStatus({ kind: 'login-required', lastError: 'Backend indisponivel' });
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await apiFetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Credenciais invalidas');
    }
    const data = (await response.json()) as { token: string; user: CurrentUser };
    writeStoredToken(data.token);
    setStatus({ kind: 'authenticated', user: data.user, token: data.token });
  }, []);

  const setupAdmin = useCallback(async (username: string, password: string, fullName: string) => {
    const response = await apiFetch(`${API_BASE}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, fullName })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Setup falhou');
    }
    const data = (await response.json()) as { token: string; user: CurrentUser };
    writeStoredToken(data.token);
    setStatus({ kind: 'authenticated', user: data.user, token: data.token });
  }, []);

  const logout = useCallback(() => {
    writeStoredToken(null);
    setStatus({ kind: 'login-required' });
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const user = status.kind === 'authenticated' ? status.user : null;
    const token = status.kind === 'authenticated' ? status.token : null;
    return {
      status,
      user,
      token,
      isAuthBypassed,
      login,
      setupAdmin,
      logout,
      refresh: bootstrap,
      hasRole: (...roles: UserRole[]) => !!user && roles.includes(user.role)
    };
  }, [status, isAuthBypassed, login, setupAdmin, logout, bootstrap]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

let currentToken: string | null = null;

export function setAuthFetchToken(token: string | null) {
  currentToken = token;
}

export function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const token = currentToken || readStoredToken();
  let isBackend = false;
  try {
    isBackend = new URL(input).origin === new URL(API_BASE).origin;
  } catch {
    // Relative or malformed URLs cannot establish the backend's origin.
  }
  if (token && isBackend && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return apiFetch(input, { ...init, headers });
}
