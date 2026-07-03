import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { applyThemePref } from '../lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  );

  // O tema também muda fora deste botão (onboarding de 1.º arranque, modo
  // 'system' a seguir o Windows) — observa o data-theme para não ficar stale.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  function toggle() {
    // Escolha explícita fixa o tema (substitui um eventual 'system' guardado).
    applyThemePref(theme === 'dark' ? 'light' : 'dark');
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
    >
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      <span>{theme === 'dark' ? 'Claro' : 'Escuro'}</span>
    </button>
  );
}
