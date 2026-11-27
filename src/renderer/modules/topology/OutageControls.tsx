import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button, Field, Message, Select } from '../../components';
import { NETWORK_API, networkRequest } from './network-health';
import { useLive } from '../router/useLive';

type Site = { id: number; name: string };
const NEW_SITE = '__novo__';

/**
 * O local físico do equipamento (torre, poste, casa). Escolhe-se de uma lista; um local novo
 * escreve-se uma vez e passa a estar na lista. Grava ao escolher.
 */
export function SitePicker({ deviceId, siteId, canManage, onChanged }: { deviceId: number; siteId: number | null; canManage: boolean; onChanged?: () => void }) {
  // Os locais quase não mudam: lê-se ao abrir e depois de criar um.
  const sites = useLive<Site[]>(`${NETWORK_API}/sites`, true, 600_000);
  const [value, setValue] = useState(siteId === null ? '' : String(siteId));
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(siteId === null ? '' : String(siteId)); setDraft(null); }, [deviceId, siteId]);

  // Uma resposta que não seja lista (erro, teste sem esta rota) não pode partir a ficha.
  const siteList = Array.isArray(sites.data) ? sites.data : null;
  const current = siteList?.find((site) => String(site.id) === value);
  if (!canManage) return <>{current?.name ?? 'Não informado'}</>;

  const save = async (next: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await networkRequest(`/sites/device/${deviceId}`, { method: 'PUT', body: { siteId: next } });
      setValue(next === null ? '' : String(next));
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível guardar o local.');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const name = draft?.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const site = await networkRequest<Site>('/sites', { method: 'POST', body: { name } });
      sites.reload();
      setDraft(null);
      await save(site.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível criar o local.');
      setBusy(false);
    }
  };

  return (
    <div className="site-picker">
      {draft === null ? (
        <Select label="Local" hideLabel value={value} disabled={busy || !siteList}
          onChange={(event) => {
            if (event.target.value === NEW_SITE) { setDraft(''); return; }
            void save(event.target.value === '' ? null : Number(event.target.value));
          }}>
          <option value="">Sem local</option>
          {siteList?.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          <option value={NEW_SITE}>Novo local…</option>
        </Select>
      ) : (
        <div className="site-picker-new">
          <Field label="Novo local" value={draft} maxLength={80} autoFocus disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }} />
          <Button size="sm" loading={busy} disabled={!draft.trim()} onClick={() => void create()}>Guardar</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>Cancelar</Button>
        </div>
      )}
      {error && <Message tone="error">{error}</Message>}
    </div>
  );
}

/** Hora local de um carimbo SQL em UTC, só horas e minutos. */
function localTime(at: string): string {
  return new Date(`${at.replace(' ', 'T')}Z`).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

/**
 * "Vou reiniciar": durante 10 minutos, a queda deste equipamento e de tudo o que lhe está
 * pendurado fica como reinício programado: sem sino, sem aviso aos clientes, fora da disponibilidade.
 */
export function PlannedRebootButton({ deviceId }: { deviceId: number }) {
  const planned = useLive<Record<string, string>>(`${NETWORK_API}/planned-reboots`, true, 30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const until = planned.data?.[String(deviceId)];

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await networkRequest(`/planned-reboots/${deviceId}`, { method: until ? 'DELETE' : 'POST' });
      planned.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível marcar o reinício.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {until ? (
        <span className="planned-reboot">
          <span className="planned-reboot-state" role="status">A reiniciar até {localTime(until)}</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggle()}>Cancelar</Button>
        </span>
      ) : (
        <Button variant="ghost" size="sm" leadingIcon={<RotateCcw size={14} aria-hidden />} disabled={busy} onClick={() => void toggle()}>
          Vou reiniciar
        </Button>
      )}
      {error && <Message tone="error">{error}</Message>}
    </>
  );
}
