import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { applyThemePref, readThemePref, systemTheme, type ThemePref } from '../lib/theme';

/**
 * Primeiro arranque: sem preferência guardada, sugere acompanhar o tema do
 * Windows (mostrando o detetado) ou fixar claro/escuro. Uma escolha, uma vez;
 * depois o ThemeToggle no topo continua disponível para mudar.
 */
export function ThemeOnboarding() {
  const [open, setOpen] = useState(() => readThemePref() === null);
  if (!open) return null;

  const detected = systemTheme();

  function choose(pref: ThemePref) {
    applyThemePref(pref);
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      size="sm"
      eyebrow="Primeiro arranque"
      title="Tema da aplicação"
      closeOnBackdrop={false}
      onClose={() => choose('system')}
    >
      <p className="theme-onboarding-lead">
        O Windows está em modo {detected === 'dark' ? 'escuro' : 'claro'}. Como preferes o ISPM?
      </p>
      <div className="theme-onboarding-options">
        <Button
          variant="primary"
          leadingIcon={<Monitor size={14} aria-hidden />}
          onClick={() => choose('system')}
        >
          Acompanhar o Windows
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<Sun size={14} aria-hidden />}
          onClick={() => choose('light')}
        >
          Modo claro
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<Moon size={14} aria-hidden />}
          onClick={() => choose('dark')}
        >
          Modo escuro
        </Button>
      </div>
      <p className="theme-onboarding-note">
        Acompanhar o Windows muda automaticamente quando o sistema alterna entre claro e escuro.
        Podes mudar a qualquer momento no botão de tema, no topo.
      </p>
    </Dialog>
  );
}
