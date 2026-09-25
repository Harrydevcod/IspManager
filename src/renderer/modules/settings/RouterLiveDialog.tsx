import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, Field } from '../../components';
import type { RouterEnforcementState } from './NetworkTab';
import type { SettingsFormState } from './settingsForm';

type RouterLiveDialogProps = {
  open: boolean;
  form: SettingsFormState;
  routerState: RouterEnforcementState | null;
  busy: boolean;
  error: string | null;
  onConfirm: (password: string) => void;
  onClose: () => void;
};

/**
 * Desligar o ensaio é a gravação que arma cortes a sério no router. Antes de a
 * pedir, diz em concreto o que passa a acontecer e pede a password do admin
 * outra vez — o servidor recusa a passagem sem ela.
 */
export function RouterLiveDialog({ open, form, routerState, busy, error, onConfirm, onClose }: RouterLiveDialogProps) {
  const [password, setPassword] = useState('');

  // A password nunca fica em memória: sai ao enviar e entre aberturas.
  useEffect(() => {
    setPassword('');
  }, [open]);

  const candidates = routerState?.autoSuspension?.candidateCount ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Router de gestão"
      title="Passar o router a modo efetivo?"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button
            variant="danger"
            leadingIcon={<ShieldAlert size={16} aria-hidden />}
            loading={busy}
            onClick={() => {
              onConfirm(password);
              setPassword('');
            }}
          >
            Passar a efetivo
          </Button>
        </>
      }
    >
      <p className="router-live-lead">
        Com o ensaio desligado, o ISPM deixa de só calcular: passa a alterar o MikroTik de gestão
        a sério, sozinho, a cada passagem de reconciliação.
      </p>
      <ul className="router-live-effects">
        <li>Corta e repõe o acesso dos clientes conforme o estado do serviço no ISPM.</li>
        <li>Cria os utilizadores PPPoE em falta e põe cada um no perfil PPP do plano.</li>
        {form.autoSuspensionEnabled ? (
          <li>
            Suspende os serviços em dívida há mais de {form.autoSuspensionGraceDays} dias — até{' '}
            {form.autoSuspensionMaxPerRun} por passagem e nunca mais de {form.autoSuspensionMaxPercent}% da base ativa.
          </li>
        ) : (
          <li>A suspensão automática por falta de pagamento está desligada: ninguém é suspenso por dívida.</li>
        )}
      </ul>
      {routerState && (
        <p className="router-live-lead">
          No último relatório do ensaio: <strong>{routerState.divergences}</strong>{' '}
          {routerState.divergences === 1 ? 'divergência por aplicar' : 'divergências por aplicar'}
          {form.autoSuspensionEnabled && (
            <>
              {' '}e <strong>{candidates}</strong>{' '}
              {candidates === 1 ? 'serviço elegível' : 'serviços elegíveis'} para suspensão
            </>
          )}
          .
        </p>
      )}
      <p className="license-reason">
        Confira o relatório do ensaio contra o parque real antes de confirmar. Voltar ao ensaio é
        possível a qualquer momento, sem password.
      </p>
      <Field
        label="Password de administrador"
        type="password"
        autoComplete="current-password"
        hint="Só administradores podem desligar o ensaio."
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={error ?? undefined}
      />
    </Dialog>
  );
}
