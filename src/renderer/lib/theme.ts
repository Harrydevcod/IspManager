export type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'ispm-theme';

/** Preferência guardada; null = primeiro arranque (nunca escolheu). */
export function readThemePref(): ThemePref | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

/** Tema atual do Windows/OS, via prefers-color-scheme. */
export function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? systemTheme() : pref;
}

export function applyThemePref(pref: ThemePref): void {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // O bootstrap FOUC (index.html) fixa um background inline do tema do
  // arranque; com o body transparente ele venceria o CSS ao trocar de tema.
  document.documentElement.style.background = '';
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* localStorage indisponivel — preferencia nao persiste, sem impacto funcional */
  }
}

/** Mantém o tema colado ao Windows enquanto a preferência for 'system'. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    if (readThemePref() === 'system') applyThemePref('system');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
