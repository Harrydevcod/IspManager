import { useEffect, useId, useState } from 'react';
import { Button, Field } from '../../components';
import { authFetch } from '../../lib/auth';

type RouterProfileOption = { name: string; rateLimit: string | null; ownerPlanId: number | null };
type ProfilesResponse = { available: boolean; reason?: string; baseProfile: string; profiles: RouterProfileOption[] };
type ApplyResponse = {
  dryRun: boolean;
  applied: boolean;
  action: { kind: 'create' | 'update' | 'none'; name?: string; rateLimit?: string; detail?: string };
};

type RouterProfileFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Plano já gravado: só esse se cria/atualiza no router (a rota lê da base). */
  savedPlan: { id: number; routerProfile: string | null } | null;
  canWriteRouter: boolean;
};

/**
 * Perfil PPP do plano (ADR 0011). A lista vem do router; pode escolher-se um
 * perfil existente ou escrever um nome novo e pedir ao ISPM que o crie.
 */
export function RouterProfileField({ value, onChange, savedPlan, canWriteRouter }: RouterProfileFieldProps) {
  const listId = `router-profiles-${useId()}`;
  const [router, setRouter] = useState<ProfilesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function loadProfiles() {
    return authFetch('http://127.0.0.1:3001/api/network/router/profiles')
      .then((response) => response.json() as Promise<ProfilesResponse>)
      .then(setRouter)
      .catch(() => setRouter({ available: false, reason: 'Não foi possível ler os perfis do router.', baseProfile: 'default', profiles: [] }));
  }

  useEffect(() => {
    void loadProfiles();
  }, []);

  const name = value.trim();
  const match = router?.profiles.find((profile) => profile.name === name) ?? null;
  const ours = Boolean(match && savedPlan && match.ownerPlanId === savedPlan.id);

  let status: string;
  if (!router) status = 'A ler os perfis do router…';
  else if (!router.available) status = router.reason ?? 'Router indisponível.';
  else if (!name) status = 'Em branco, o ISPM dá ao plano o perfil ispm-plano-<nº> e cria-o no router ao gravar.';
  else if (!match) status = `Ainda não existe no router. O ISPM cria-o a partir do perfil-base ${router.baseProfile} ao gravar.`;
  else if (ours) status = `Existe no router · ${match.rateLimit ?? 'sem limite'} · criado pelo ISPM`;
  else status = `Existe no router · ${match.rateLimit ?? 'sem limite'} · feito no router, o ISPM não lhe mexe`;

  // A rota trabalha com o que está gravado: com o nome por gravar, gravar primeiro.
  const saved = Boolean(savedPlan && (savedPlan.routerProfile ?? '') === name);
  const actionLabel = !match ? 'Criar no router' : ours ? 'Atualizar no router' : null;
  const showAction = canWriteRouter && router?.available && name && actionLabel;

  async function apply() {
    if (!savedPlan) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/plans/${savedPlan.id}/router-profile`, { method: 'POST' });
      const body = (await response.json()) as ApplyResponse & { error?: string };
      if (!response.ok) {
        setMessage(body.error ?? 'O router recusou o pedido.');
        return;
      }
      const { action } = body;
      if (action.kind === 'none') setMessage(action.detail ?? 'Nada a fazer.');
      else if (body.dryRun) setMessage(`Em ensaio: ${action.kind === 'create' ? 'criaria' : 'atualizaria'} o perfil ${action.name} com ${action.rateLimit}. Nada foi alterado no router.`);
      else setMessage(`Perfil ${action.name} ${action.kind === 'create' ? 'criado' : 'atualizado'} no router com ${action.rateLimit}.`);
      await loadProfiles();
    } catch {
      setMessage('Falha de rede ao falar com o ISPM.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wide-field router-profile-field">
      <Field
        label="Perfil PPP no router"
        value={value}
        maxLength={64}
        list={listId}
        placeholder="ex.: plano-20M"
        onChange={(event) => onChange(event.target.value)}
        hint={status}
      />
      <datalist id={listId}>
        {router?.profiles.map((profile) => (
          <option key={profile.name} value={profile.name}>{profile.rateLimit ?? 'sem limite'}</option>
        ))}
      </datalist>
      {showAction && (
        <div className="router-profile-actions">
          <Button type="button" variant="secondary" disabled={!saved || busy} onClick={() => void apply()}>
            {busy ? 'A falar com o router…' : actionLabel}
          </Button>
          {!saved && <span className="field-hint">Grave o plano primeiro: o router recebe o que está gravado.</span>}
        </div>
      )}
      {message && <p className="field-hint" role="status">{message}</p>}
    </div>
  );
}
