import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Message } from '../components';
import { Toggle } from '../components/Toggle';

type State = { available: boolean; enabled: boolean; active: boolean };

/**
 * Consentimento para enviar relatórios de erro à Sentry. Desligado por omissão.
 * Só existe na app empacotada (no browser não há `window.ispm`) e só aparece
 * quando o build traz um DSN.
 */
export function ErrorReportsPanel() {
  const [state, setState] = useState<State | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.ispm?.getErrorReports?.().then(setState);
  }, []);

  if (!state?.available) return null;

  async function toggle(enabled: boolean) {
    setSaving(true);
    try {
      if (await window.ispm?.setErrorReports?.(enabled)) setState((s) => (s ? { ...s, enabled } : s));
    } finally {
      setSaving(false);
    }
  }

  const pendingRestart = state.enabled !== state.active;

  return (
    <section className="job-health-panel">
      <header className="backups-head">
        <div>
          <h3>Relatórios de erro</h3>
          <p className="license-reason">
            Nunca envia dados de clientes.
          </p>
        </div>
      </header>
      <Toggle
        title="Enviar relatórios de erro"
        description="Aplica-se ao reiniciar."
        checked={state.enabled}
        disabled={saving}
        onChange={(event) => void toggle(event.target.checked)}
      />
      {pendingRestart && (
        <Message tone="neutral">
          {state.enabled ? 'Os relatórios começam' : 'Os relatórios param'} depois de reiniciar.{' '}
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<RotateCcw size={14} aria-hidden />}
            onClick={() => void window.ispm?.relaunch?.()}
          >
            Reiniciar agora
          </Button>
        </Message>
      )}
    </section>
  );
}
