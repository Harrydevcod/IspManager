import { AlertTriangle, Unlink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { LINK_MEDIA, LINK_MEDIUM_LABELS, type LinkMedium, type TopologyLinkProperties } from '../../../shared/topology';
import { Button, Dialog, Field, Select, Textarea } from '../../components';
import { isRadio } from './link-format';
import './LinkDialog.css';

/** Uma ponta da ligação, com as portas do router quando é o router de gestão. */
export type LinkEnd = {
  name: string;
  /** Interfaces lidas do router ao vivo: aí a porta escolhe-se, não se escreve. */
  interfaces: string[] | null;
};

type Props = {
  open: boolean;
  upstream: LinkEnd;
  device: LinkEnd;
  link: TopologyLinkProperties | undefined;
  pending: boolean;
  error: string | null;
  onSave: (link: TopologyLinkProperties) => void;
  onRemove: () => void;
  onClose: () => void;
};

type FormState = {
  medium: LinkMedium | '';
  fromPort: string;
  toPort: string;
  frequencyMhz: string;
  capacityMbps: string;
  notes: string;
};

function formState(link: TopologyLinkProperties | undefined): FormState {
  return {
    medium: link?.medium ?? '',
    fromPort: link?.fromPort ?? '',
    toPort: link?.toPort ?? '',
    frequencyMhz: link?.frequencyMhz ? String(link.frequencyMhz) : '',
    capacityMbps: link?.capacityMbps ? String(link.capacityMbps) : '',
    notes: link?.notes ?? ''
  };
}

function wholeNumber(value: string, max: number): number | null | 'invalid' {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : 'invalid';
}

function PortField({ label, end, value, onChange }: {
  label: string;
  end: LinkEnd;
  value: string;
  onChange: (value: string) => void;
}) {
  if (end.interfaces && end.interfaces.length > 0) {
    // Valor guardado que o router já não tem continua visível, para não se perder em silêncio.
    const options = value && !end.interfaces.includes(value) ? [value, ...end.interfaces] : end.interfaces;
    return (
      <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Por indicar</option>
        {options.map((name) => <option key={name} value={name}>{name}</option>)}
      </Select>
    );
  }
  return <Field label={label} value={value} maxLength={40} placeholder="ether1, wlan1…" onChange={(event) => onChange(event.target.value)} />;
}

export function LinkDialog({ open, upstream, device, link, pending, error, onSave, onRemove, onClose }: Props) {
  const [form, setForm] = useState<FormState>(() => formState(link));
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(formState(link));
    setValidation(null);
  }, [open, link]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const frequencyMhz = isRadio(form.medium || null) ? wholeNumber(form.frequencyMhz, 100_000) : null;
    const capacityMbps = wholeNumber(form.capacityMbps, 1_000_000);
    if (frequencyMhz === 'invalid') return setValidation('Frequência: um número inteiro de MHz, por exemplo 5800.');
    if (capacityMbps === 'invalid') return setValidation('Capacidade: um número inteiro de Mbps.');
    setValidation(null);
    onSave({
      medium: form.medium || null,
      fromPort: form.fromPort.trim() || null,
      toPort: form.toPort.trim() || null,
      frequencyMhz,
      capacityMbps,
      notes: form.notes.trim() || null
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Ligação"
      title={`${upstream.name} → ${device.name}`}
      size="md"
      closeOnBackdrop={!pending}
      actions={(
        <>
          <Button variant="danger" leadingIcon={<Unlink size={15} aria-hidden />} onClick={onRemove} disabled={pending}>
            Remover ligação
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancelar</Button>
          <Button type="submit" form="link-editor-form" loading={pending}>Guardar</Button>
        </>
      )}
    >
      <form id="link-editor-form" className="link-editor-form" onSubmit={submit}>
        {(validation || error) && (
          <div className="backbone-dialog-error" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <span>{validation || error}</span>
          </div>
        )}
        <Select label="Meio" value={form.medium} onChange={(event) => update('medium', event.target.value as LinkMedium | '')}>
          <option value="">Por classificar</option>
          {LINK_MEDIA.map((medium) => <option key={medium} value={medium}>{LINK_MEDIUM_LABELS[medium]}</option>)}
        </Select>
        <div className="link-editor-pair">
          <PortField label={`Porta em ${upstream.name}`} end={upstream} value={form.fromPort} onChange={(value) => update('fromPort', value)} />
          <PortField label={`Porta em ${device.name}`} end={device} value={form.toPort} onChange={(value) => update('toPort', value)} />
        </div>
        <div className="link-editor-pair">
          {isRadio(form.medium || null) && (
            <Field label="Frequência (MHz)" inputMode="numeric" value={form.frequencyMhz} placeholder="5800" onChange={(event) => update('frequencyMhz', event.target.value)} />
          )}
          <Field label="Capacidade (Mbps)" inputMode="numeric" value={form.capacityMbps} placeholder="450" onChange={(event) => update('capacityMbps', event.target.value)} />
        </div>
        <Textarea label="Notas" value={form.notes} maxLength={500} rows={2} onChange={(event) => update('notes', event.target.value)} />
        <p className="link-editor-hint">
          Sinal e SNR não se escrevem aqui: só aparecem quando houver monitorização das próprias antenas.
        </p>
      </form>
    </Dialog>
  );
}
