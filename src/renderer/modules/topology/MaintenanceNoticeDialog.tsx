import { apiUrl } from '../../lib/api';
import { useEffect, useState } from 'react';
import { Button, Dialog, Field, Message, Select } from '../../components';
import { authFetch } from '../../lib/auth';
import { businessDay } from '../../../shared/business-day';

type Preview = { total: number; whatsapp: number; sms: number; skipped: number };
type Kind = 'manutencao' | 'calibracao' | 'configuracao';

const KINDS: Array<[Kind, string]> = [['manutencao', 'Manutenção'], ['calibracao', 'Calibração'], ['configuracao', 'Mudança de configuração']];

/** Avisa os clientes pendurados numa torre ou ramo de uma janela de manutenção. */
export function MaintenanceNoticeDialog({ deviceId, deviceName, open, onClose }: { deviceId: number; deviceName: string; open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('manutencao');
  const [day, setDay] = useState(businessDay());
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('11:00');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const url = apiUrl(`/api/backbone/${deviceId}/maintenance-notice`);

  useEffect(() => {
    if (!open) return;
    setResult(null); setError('');
    authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'manutencao', day: businessDay(), start: '09:00', end: '10:00', dryRun: true }) })
      .then(async (response) => { if (response.ok) setPreview(await response.json() as Preview); })
      .catch(() => setPreview(null));
  }, [open, url]);

  async function send() {
    setBusy(true); setError('');
    try {
      const response = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, day, start, end }) });
      const body = await response.json().catch(() => ({})) as Preview & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Não foi possível enviar o aviso.');
      setResult(body);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível enviar o aviso.'); }
    finally { setBusy(false); }
  }

  const invalid = !day || day < businessDay() || end <= start;
  return <Dialog open={open} onClose={onClose} eyebrow={deviceName} title="Aviso de manutenção"
    actions={result
      ? <Button variant="primary" onClick={onClose}>Fechar</Button>
      : <>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={busy} disabled={invalid || !preview?.total} onClick={() => void send()}>
          {preview ? `Avisar ${preview.whatsapp + preview.sms} cliente(s)` : 'Avisar'}
        </Button>
      </>}>
    {result
      ? <Message tone="success">{result.whatsapp + result.sms} na fila · {result.whatsapp} por WhatsApp · {result.sms} por SMS{result.skipped ? ` · ${result.skipped} sem canal ou telefone` : ''}</Message>
      : <div className="maintenance-notice-form">
        <Select label="Tipo" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
          {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Field label="Data" type="date" min={businessDay()} value={day} onChange={(event) => setDay(event.target.value)} />
        <Field label="Início" type="time" value={start} onChange={(event) => setStart(event.target.value)} />
        <Field label="Fim" type="time" value={end} onChange={(event) => setEnd(event.target.value)} error={end <= start ? 'Depois do início' : undefined} />
        {preview && <p className="maintenance-notice-count">{preview.total} cliente(s) a jusante · {preview.whatsapp} WhatsApp · {preview.sms} SMS{preview.skipped ? ` · ${preview.skipped} sem canal ou telefone` : ''}</p>}
      </div>}
    {error && <Message tone="error">{error}</Message>}
  </Dialog>;
}
