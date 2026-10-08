import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Dialog, Field, Message, Select, Textarea } from '../../components';
import { networkRequest, type DiaryEntry, type DiaryStatus } from './network-health';

type Form = { happenedAt: string; title: string; cause: string; resolution: string; status: DiaryStatus };

const pad = (value: number) => String(value).padStart(2, '0');
/** Agora, no formato do `<input type="datetime-local">`. */
function nowLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Registar ou atualizar uma ocorrência de rede: o que foi, a causa e como se resolveu.
 * Abre-se no cartão do painel e na aba Incidentes; `entry` distingue editar de criar.
 */
export function NetworkDiaryDialog({ open, entry, onClose, onSaved }: {
  open: boolean;
  entry?: DiaryEntry | null;
  onClose: () => void;
  onSaved: (entry: DiaryEntry) => void;
}) {
  const [form, setForm] = useState<Form>({ happenedAt: nowLocal(), title: '', cause: '', resolution: '', status: 'aberta' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(entry
      ? { happenedAt: entry.happenedAt, title: entry.title, cause: entry.cause, resolution: entry.resolution, status: entry.status }
      : { happenedAt: nowLocal(), title: '', cause: '', resolution: '', status: 'aberta' });
  }, [open, entry]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await networkRequest<DiaryEntry>(entry ? `/diary/${entry.id}` : '/diary', { method: entry ? 'PATCH' : 'POST', body: form }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível gravar a ocorrência.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} eyebrow="Diário da rede" title={entry ? 'Ocorrência' : 'Nova ocorrência'} size="md"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="network-diary-form" loading={saving}>{entry ? 'Guardar' : 'Registar'}</Button>
        </>
      )}>
      <form id="network-diary-form" className="client-form" onSubmit={submit}>
        <Field label="Quando" type="datetime-local" required value={form.happenedAt}
          onChange={(event) => setForm({ ...form, happenedAt: event.target.value })} />
        <Select label="Estado" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as DiaryStatus })}>
          <option value="aberta">Aberta</option>
          <option value="resolvida">Resolvida</option>
        </Select>
        <Field label="Situação" wide required maxLength={140} value={form.title}
          onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Ex.: antenas a cair em conjunto" />
        <Textarea label="Causa" rows={2} maxLength={2000} value={form.cause}
          onChange={(event) => setForm({ ...form, cause: event.target.value })} />
        <Textarea label="Como se resolveu" rows={2} maxLength={2000} value={form.resolution}
          onChange={(event) => setForm({ ...form, resolution: event.target.value })} />
        {error && <Message tone="error">{error}</Message>}
      </form>
    </Dialog>
  );
}
