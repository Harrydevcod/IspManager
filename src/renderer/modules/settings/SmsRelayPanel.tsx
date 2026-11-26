import { apiUrl } from '../../lib/api';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Unlink } from 'lucide-react';
import { Button, Field, Message } from '../../components';
import { authFetch } from '../../lib/auth';
import { olderVersion } from './smsPresence';

const RELAY_API = apiUrl('/api/sms/relay');

export type SmsRelayState = { url: string; adminKeyConfigured: boolean; phoneSynced: boolean; needsPairing: boolean; appVersion?: string | null };

/** A primeira versão da app que consulta o relé. */
const RELAY_APP_VERSION = '0.12.0';

/** Uma linha de estado; a cor reforça, o texto já diz tudo. */
export function describeSmsRelay(state: SmsRelayState): { tone: 'success' | 'warn' | 'muted'; line: string } {
  if (!state.url) return { tone: 'muted', line: 'Sem relé: o telemóvel só responde na rede local' };
  if (state.needsPairing) return { tone: 'warn', line: 'O relé exige parear de novo o telemóvel' };
  if (state.phoneSynced) return { tone: 'success', line: 'Endereço do relé entregue ao telemóvel' };
  if (state.appVersion && olderVersion(state.appVersion, RELAY_APP_VERSION)) {
    return { tone: 'warn', line: `O relé exige a app ${RELAY_APP_VERSION} no telemóvel (tem a ${state.appVersion})` };
  }
  return { tone: 'warn', line: 'À espera do telemóvel na rede local para lhe entregar o endereço' };
}

/** Ligação ao telemóvel fora da rede local (ADR 0024). */
export function SmsRelayPanel() {
  const [state, setState] = useState<SmsRelayState | null>(null);
  const [url, setUrl] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void authFetch(RELAY_API)
      .then(async (response) => {
        if (!active || !response.ok) return;
        const next = (await response.json()) as SmsRelayState;
        setState(next);
        setUrl(next.url);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  // À espera do telemóvel: o estado muda sozinho quando ele recebe o endereço.
  const waiting = Boolean(state?.url) && !state?.phoneSynced;
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => {
      void authFetch(RELAY_API)
        .then(async (response) => { if (response.ok) setState((await response.json()) as SmsRelayState); })
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [waiting]);

  async function save(nextUrl: string) {
    setSaving(true);
    setError('');
    try {
      const response = await authFetch(RELAY_API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: nextUrl, adminKey: adminKey || undefined })
      });
      const body = (await response.json().catch(() => ({}))) as SmsRelayState & { error?: string };
      if (!response.ok) {
        setError(body.error || 'Não foi possível guardar o relé.');
        return;
      }
      setState(body);
      setUrl(body.url);
      setAdminKey('');
    } catch {
      setError('Não foi possível guardar o relé.');
    } finally {
      setSaving(false);
    }
  }

  // Dentro do formulário das Definições: Enter guarda o relé, não o formulário todo.
  function onEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void save(url);
  }

  if (!state) return null;
  const view = describeSmsRelay(state);
  const dirty = url.trim() !== state.url || adminKey !== '';

  return (
    <div className="settings-test-whatsapp sms-relay-panel" role="group" aria-label="Relé fora da rede local">
      <span className="sms-pairing-state" data-tone={view.tone} role="status">{view.line}</span>
      <div className="sms-relay-fields">
        <Field
          label="Endereço do relé"
          type="url"
          inputMode="url"
          placeholder="https://…workers.dev"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={onEnter}
        />
        <Field
          label="Chave de administração"
          type="password"
          autoComplete="new-password"
          placeholder={state.adminKeyConfigured ? 'Guardada' : ''}
          value={adminKey}
          onChange={(event) => setAdminKey(event.target.value)}
          onKeyDown={onEnter}
        />
      </div>
      {error && <Message tone="error">{error}</Message>}
      <div className="sms-pairing-actions">
        <Button variant="primary" onClick={() => void save(url)} loading={saving} disabled={!dirty || !url.trim()}>
          Guardar relé
        </Button>
        {state.url && (
          <Button variant="critical" onClick={() => void save('')} disabled={saving} leadingIcon={<Unlink size={14} aria-hidden />}>
            Remover relé
          </Button>
        )}
      </div>
    </div>
  );
}
