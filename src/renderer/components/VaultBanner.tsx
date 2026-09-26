import { AlertTriangle, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { authFetch, useAuth } from '../lib/auth';
import { Button } from './Button';

type VaultStatus = 'ready' | 'recovery_pending' | 'locked' | 'absent';
type VaultReading = { status: VaultStatus; migrationError?: string };

/** O painel do cofre avisa por aqui quando muda o estado; o aviso volta a ler. */
export const VAULT_CHANGED_EVENT = 'ispm:vault-changed';

export function announceVaultChanged(): void {
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
}

/**
 * Um cofre novo fica com a chave de recuperação por entregar até o administrador
 * a guardar. Se isso só se visse em Configurações → Cofre, ninguém dava por ela e
 * um backup restaurado noutro computador ficava sem credenciais para sempre.
 */
export function VaultBanner({ onOpen }: { onOpen: () => void }) {
  const auth = useAuth();
  const allowed = auth.isAuthBypassed || auth.hasRole('admin');
  const [reading, setReading] = useState<VaultReading | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    const read = () => {
      authFetch('http://127.0.0.1:3001/api/vault/status')
        .then(async (response) => (response.ok ? await response.json() as VaultReading : null))
        .then((next) => { if (alive) setReading(next); })
        .catch(() => { if (alive) setReading(null); });
    };
    read();
    window.addEventListener(VAULT_CHANGED_EVENT, read);
    return () => {
      alive = false;
      window.removeEventListener(VAULT_CHANGED_EVENT, read);
    };
  }, [allowed]);

  if (!allowed || !reading) return null;

  const notice = reading.migrationError
    ? { tone: 'danger', icon: AlertTriangle, text: 'Há credenciais por converter para o cofre: as integrações e os backups normais estão parados.', action: 'Abrir cofre' }
    : reading.status === 'locked'
      ? { tone: 'danger', icon: AlertTriangle, text: 'O cofre está trancado: as integrações e os backups normais estão parados.', action: 'Desbloquear' }
      : reading.status === 'recovery_pending'
        ? { tone: 'warn', icon: KeyRound, text: 'Guarde a chave de recuperação do cofre. Sem ela, um backup restaurado noutro computador fica sem credenciais.', action: 'Abrir cofre' }
        : null;
  if (!notice) return null;

  const Icon = notice.icon;
  return (
    <div className={`shell-banner shell-banner-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={16} aria-hidden />
      <p>{notice.text}</p>
      <Button size="sm" variant={notice.tone === 'danger' ? 'primary' : 'secondary'} onClick={onOpen}>{notice.action}</Button>
    </div>
  );
}
