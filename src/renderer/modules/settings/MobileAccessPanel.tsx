import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Field, Message, Select } from '../../components';
import { apiUrl } from '../../lib/api';
import { authFetch } from '../../lib/auth';

type Status = {running: boolean; host: string | null; port: number | null; addresses: string[]};
const API = apiUrl('/api/mobile-access');

export function MobileAccessPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('38421');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);

  useEffect(() => {
    let active = true;
    async function load() {
      const generation = epoch.current;
      try {
        const response = await authFetch(API);
        if (!response.ok) throw new Error();
        const next = await response.json() as Status;
        if (!active || generation !== epoch.current) return;
        setStatus(next);
        setAddress(current => next.addresses.includes(current) ? current : '');
        setError(current => current === 'Não foi possível consultar o acesso móvel.' ? '' : current);
      } catch { if (active && generation === epoch.current) setError('Não foi possível consultar o acesso móvel.'); }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function change(start: boolean) {
    if (busy || !status) return;
    if (start && (!address || !password || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      setError('Escolha a rede, uma porta válida e confirme a password.');
      return;
    }
    epoch.current++;
    setBusy(true);
    setError('');
    try {
      const response = await authFetch(`${API}/${start ? 'start' : 'stop'}`, {
        method: 'POST',
        ...(start ? {headers: {'Content-Type':'application/json'}, body: JSON.stringify({host:address, port:Number(port), confirmPassword:password})} : {})
      });
      const result = await response.json().catch(() => ({})) as {running?: boolean; host?: string | null; port?: number | null; error?: string};
      if (!response.ok) throw new Error(result.error || 'Não foi possível alterar o acesso móvel.');
      setStatus(previous => previous ? {...previous, running:result.running === true, host:result.host ?? null, port:result.port ?? null} : previous);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível alterar o acesso móvel.');
    } finally { epoch.current++; setPassword(''); setBusy(false); }
  }

  function preventFormSubmit(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') { event.preventDefault(); void change(true); }
  }

  return (
    <section className="mobile-access-panel" aria-labelledby="mobile-access-title">
      <div className="mobile-access-heading">
        <div><h3 id="mobile-access-title">ISPM no telemóvel</h3><p>Use o ISPM no Android pareado enquanto o computador está ligado à mesma rede.</p></div>
        <span className="sms-pairing-state" data-tone={status?.running ? 'success' : 'muted'} role="status">{status ? status.running ? 'Ativo' : 'Desligado' : 'A verificar…'}</span>
      </div>
      {status?.running ? (
        <div className="mobile-access-active"><span>{status.host}:{status.port}</span><Button variant="secondary" loading={busy} onClick={() => void change(false)}>Desligar acesso</Button></div>
      ) : status && (
        <div className="mobile-access-fields">
          <Select label="Rede do computador" value={address} onChange={event => setAddress(event.target.value)} disabled={busy || status.addresses.length === 0}>
            <option value="">{status.addresses.length === 0 ? 'Sem rede disponível' : 'Escolha a rede'}</option>
            {status.addresses.map(value => <option key={value} value={value}>{value}</option>)}
          </Select>
          <Field label="Porta" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} onKeyDown={preventFormSubmit} disabled={busy} />
          <Field label="Password de administrador" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} onKeyDown={preventFormSubmit} disabled={busy} />
          <Button loading={busy} disabled={!address || !password} onClick={() => void change(true)}>Ativar acesso</Button>
        </div>
      )}
      {error && <Message tone="error">{error}</Message>}
    </section>
  );
}
