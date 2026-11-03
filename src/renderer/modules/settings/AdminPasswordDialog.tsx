import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, Field } from '../../components';

type AdminPasswordDialogProps = {
  open: boolean;
  eyebrow: string;
  title: string;
  lead: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: (password: string) => void;
  onClose: () => void;
};

/**
 * Passo a mais para gravações sensíveis: a sessão aberta não chega, pede a
 * password do admin outra vez. O servidor recusa sem ela; isto é só o caminho.
 */
export function AdminPasswordDialog({ open, eyebrow, title, lead, confirmLabel, busy, error, onConfirm, onClose }: AdminPasswordDialogProps) {
  const [password, setPassword] = useState('');

  // A password nunca fica em memória: sai ao enviar e entre aberturas.
  useEffect(() => {
    setPassword('');
  }, [open]);

  function submit() {
    onConfirm(password);
    setPassword('');
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow={eyebrow}
      title={title}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            leadingIcon={<ShieldCheck size={16} aria-hidden />}
            loading={busy}
            disabled={!password}
            onClick={submit}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="router-live-lead">{lead}</p>
      <form onSubmit={(event) => { event.preventDefault(); if (password) submit(); }}>
        <Field
          label="Password de administrador"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={error ?? undefined}
        />
      </form>
    </Dialog>
  );
}
