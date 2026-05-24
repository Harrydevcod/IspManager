import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  );

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('ispm-theme', next);
    } catch {
      /* localStorage indisponivel — preferencia nao persiste, sem impacto funcional */
    }
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
