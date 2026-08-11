/**
 * Aviso de licença e diálogo de ativação.
 *
 * O aviso vive no topo da aplicação e só aparece quando há algo a fazer:
 * avaliação a decorrer, subscrição em tolerância, escrita bloqueada ou
 * manutenção terminada. Uma licença em dia não ocupa espaço.
 *
 * Não é um portão: a aplicação continua inteiramente navegável por baixo dele.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Field } from './Field';
import { Textarea } from './Textarea';
import { licenseNeedsAttention, licenseTone, useLicense } from '../lib/license';

export function LicenseBanner() {
  const { info } = useLicense();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!licenseNeedsAttention(info) || !info) return null;

  const tone = licenseTone(info);

  return (
    <>
      <div className={`license-banner license-banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
        <AlertTriangle size={16} aria-hidden />
        <p>{info.reason}</p>
        <Button size="sm" variant={tone === 'danger' ? 'primary' : 'secondary'} onClick={() => setDialogOpen(true)}>
          Ativar licença
        </Button>
      </div>
      <LicenseDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}

export function LicenseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { info, activate } = useLicense();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Substituir uma licença ativa é uma ação de administrador e exige a password
  // outra vez. Ativar numa instalação sem licença continua aberto a quem lá
  // estiver — é o que desbloqueia a operação quando a avaliação termina.
  const replacing = Boolean(info?.license);

  // Reabrir o diálogo depois de uma tentativa falhada não pode mostrar o erro
  // antigo, nem o token recusado, nem deixar a password em memória.
  useEffect(() => {
    if (open) {
      setToken('');
      setPassword('');
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (submitting) return;
    const value = token.trim();
    if (!value) {
      setError('Cole o conteúdo do ficheiro de licença.');
      return;
    }
    if (replacing && !password) {
      setError('Confirme a sua password para substituir a licença.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await activate(value, replacing ? password : undefined);
      onClose();
    } catch (err) {
      setPassword('');
      setError(err instanceof Error ? err.message : 'Não foi possível ativar a licença.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Licenciamento"
      title={replacing ? 'Substituir licença' : 'Ativar licença'}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button leadingIcon={<KeyRound size={16} aria-hidden />} loading={submitting} onClick={() => void submit()}>
            {replacing ? 'Substituir' : 'Ativar'}
          </Button>
        </>
      }
    >
      <Textarea
        label="Ficheiro de licença"
        hint="Abra o ficheiro .ispmlic que recebeu e cole aqui o conteúdo."
        rows={5}
        value={token}
        spellCheck={false}
        onChange={(event) => setToken(event.target.value)}
        error={replacing ? undefined : (error ?? undefined)}
      />
      {replacing && (
        <Field
          label="A sua password"
          type="password"
          autoComplete="current-password"
          hint={`A licença ${info?.license?.id ?? ''} vai ser substituída. Só administradores o podem fazer.`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={error ?? undefined}
        />
      )}
      {info?.fingerprint && (
        <p className="license-fingerprint">
          Identificação desta máquina: <code>{info.fingerprint}</code>
          <span>Envie-a ao suporte para receber uma licença ligada a este computador.</span>
        </p>
      )}
    </Dialog>
  );
}
