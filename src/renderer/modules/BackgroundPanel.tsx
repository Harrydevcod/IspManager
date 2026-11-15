import { useEffect, useState } from 'react';
import type { BackgroundSettings, BackgroundSettingsChange } from '../../shared/background-settings';
import { Message } from '../components';
import { Toggle } from '../components/Toggle';

export function BackgroundPanel() {
  const [state, setState] = useState<BackgroundSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.ispm?.getBackgroundSettings?.().then((next) => {
      if (active) setState(next);
    }).catch(() => { if (active) setError('Não foi possível ler as opções de segundo plano.'); });
    return () => { active = false; };
  }, []);

  async function change(value: BackgroundSettingsChange) {
    setSaving(true);
    setError('');
    try {
      const next = await window.ispm?.setBackgroundSettings?.(value);
      if (!next) throw new Error('Opções indisponíveis');
      setState(next);
    } catch {
      setError('Não foi possível guardar a opção. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  if (!window.ispm?.getBackgroundSettings || (state && !state.available)) return null;
  return (
    <section className="job-health-panel" aria-label="ISPM em segundo plano">
      <header className="backups-head">
        <div>
          <h3>ISPM em segundo plano</h3>
        </div>
      </header>
      {!state && !error && <p role="status">A ler as opções…</p>}
      {state && <>
        <Toggle
          title="Manter a correr com a janela fechada"
          description="Reabre-se pelo ícone junto ao relógio; Sair termina os automatismos."
          checked={state.keepRunning}
          disabled={saving}
          onChange={(event) => void change({ keepRunning: event.target.checked })}
        />
        {state.canStartAtLogin && <Toggle
          title="Arrancar com o Windows"
          checked={state.openAtLogin}
          disabled={saving}
          onChange={(event) => void change({ openAtLogin: event.target.checked })}
        />}
      </>}
      {error && <Message tone="error">{error}</Message>}
    </section>
  );
}
