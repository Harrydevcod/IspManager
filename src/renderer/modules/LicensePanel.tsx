/**
 * Painel de licença em Configurações: estado, dados da licença, identificação
 * da máquina e as duas ações — ativar e remover desta máquina.
 */
import { useState } from 'react';
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, Field, LicenseDialog, Message } from '../components';
import { formatPtDate } from '../../shared/date';
import { useLicense, type LicenseInfo, type LicenseState } from '../lib/license';

const STATE_LABEL: Record<LicenseState, string> = {
  trial: 'Avaliação',
  active: 'Ativa',
  grace: 'Em tolerância',
  readonly: 'Só leitura',
  invalid: 'Inválida'
};

const STATE_TONE: Record<LicenseState, 'success' | 'warn' | 'danger' | 'neutral'> = {
  trial: 'neutral',
  active: 'success',
  grace: 'warn',
  readonly: 'danger',
  invalid: 'danger'
};

function validityLine(info: LicenseInfo): string {
  const license = info.license;
  if (!license) return '—';
  if (license.kind === 'perpetua') {
    return license.maintenanceUntil
      ? `Perpétua · manutenção até ${formatPtDate(license.maintenanceUntil)}`
      : 'Perpétua · manutenção sem termo';
  }
  return license.expiresAt ? `Subscrição · válida até ${formatPtDate(license.expiresAt)}` : 'Subscrição';
}

export function LicensePanel() {
  const { info, loading, deactivate } = useLicense();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  function openRemove() {
    setPassword('');
    setRemoveError(null);
    setRemoveOpen(true);
  }

  async function remove() {
    if (removing) return;
    if (!password) {
      setRemoveError('Confirme a sua password para remover a licença.');
      return;
    }
    setRemoving(true);
    setRemoveError(null);
    try {
      await deactivate(password);
      setRemoveOpen(false);
      setPassword('');
    } catch (err) {
      // A password nunca fica em memória depois de uma recusa.
      setPassword('');
      setRemoveError(err instanceof Error ? err.message : 'Não foi possível remover a licença.');
    } finally {
      setRemoving(false);
    }
  }

  if (loading) return null;

  if (!info || !info.enabled) {
    return (
      <section className="license-panel">
        <EmptyState
          size="sm"
          icon={ShieldCheck}
          title="Licenciamento não configurado"
          description="Esta instalação não exige licença: todas as funcionalidades estão disponíveis sem restrições."
        />
      </section>
    );
  }

  return (
    <section className="license-panel">
      <header className="backups-head">
        <div>
          <h3>Licença</h3>
          <p className="license-reason">{info.reason}</p>
        </div>
        <Badge tone={STATE_TONE[info.state]}>{STATE_LABEL[info.state]}</Badge>
      </header>

      {error && <Message tone="error">{error}</Message>}

      {info.license ? (
        <dl className="license-details">
          <div>
            <dt>Cliente</dt>
            <dd>{info.license.customer}</dd>
          </div>
          <div>
            <dt>Referência</dt>
            <dd>{info.license.id}</dd>
          </div>
          <div>
            <dt>Validade</dt>
            <dd>{validityLine(info)}</dd>
          </div>
          <div>
            <dt>Emitida em</dt>
            <dd>{formatPtDate(info.license.issuedAt)}</dd>
          </div>
          <div>
            <dt>Atualizações</dt>
            <dd>{info.updatesAllowed ? 'Incluídas' : 'Manutenção terminada'}</dd>
          </div>
          <div>
            <dt>Ligação</dt>
            <dd>{info.license.bind === 'machine' ? 'Ligada a esta máquina' : 'Chave simples'}</dd>
          </div>
        </dl>
      ) : (
        <p className="license-empty">
          Sem licença ativa nesta instalação.
          {info.daysRemaining != null && info.daysRemaining > 0 && ` Avaliação: ${info.daysRemaining} dia(s) restante(s).`}
        </p>
      )}

      <p className="license-fingerprint">
        Identificação desta máquina: <code>{info.fingerprint}</code>
        <span>Envie-a ao suporte para receber uma licença ligada a este computador.</span>
      </p>

      <div className="license-actions">
        <Button leadingIcon={<KeyRound size={16} aria-hidden />} onClick={() => setDialogOpen(true)}>
          {info.license ? 'Substituir licença' : 'Ativar licença'}
        </Button>
        {info.license && (
          <Button
            variant="danger"
            leadingIcon={<Trash2 size={16} aria-hidden />}
            onClick={openRemove}
          >
            Remover desta máquina
          </Button>
        )}
      </div>

      <LicenseDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      <Dialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        eyebrow="Licenciamento"
        title="Remover a licença desta máquina?"
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoveOpen(false)}>Cancelar</Button>
            <Button
              variant="danger"
              leadingIcon={<Trash2 size={16} aria-hidden />}
              loading={removing}
              onClick={() => void remove()}
            >
              Remover
            </Button>
          </>
        }
      >
        <p className="license-reason">
          A aplicação passa a só leitura até ser ativada outra licença. Os dados não são afetados —
          continuam a poder ser consultados, impressos e exportados.
        </p>
        <Field
          label="A sua password"
          type="password"
          autoComplete="current-password"
          hint="Só administradores podem remover a licença."
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={removeError ?? undefined}
        />
      </Dialog>
    </section>
  );
}
