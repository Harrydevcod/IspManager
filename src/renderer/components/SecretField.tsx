import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button';

export type SecretDraft = { editing: false } | { editing: true; value: string };
export type SecretFieldProps = {
  label: string;
  configured: boolean;
  draft: SecretDraft;
  onDraftChange(next: SecretDraft): void;
  disabled?: boolean;
};

export function SecretField({ label, configured, draft, onDraftChange, disabled }: SecretFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (draft.editing) input.current?.focus(); }, [draft.editing]);

  function edit() {
    setVisible(false);
    onDraftChange({ editing: true, value: '' });
  }

  return <div className="field secret-field">
    <span className="field-label">{label}</span>
    {draft.editing ? <>
      <div className="secret-field-control">
        <input ref={input} id={id} aria-label={label} type={visible ? 'text' : 'password'} autoComplete="new-password"
          value={draft.value} disabled={disabled} onChange={(event) => onDraftChange({ editing: true, value: event.target.value })} />
        <Button type="button" variant="ghost" aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={visible}
          disabled={disabled} onClick={() => setVisible((current) => !current)}>{visible ? 'Ocultar' : 'Mostrar'}</Button>
      </div>
      <Button type="button" variant="ghost" disabled={disabled} onClick={() => { setVisible(false); onDraftChange({ editing: false }); }}>Cancelar</Button>
    </> : configured ? <div className="secret-field-control">
      <span>Configurada</span>
      <Button type="button" variant="ghost" disabled={disabled} onClick={edit}>Editar</Button>
    </div> : <Button type="button" variant="ghost" disabled={disabled} onClick={edit}>Adicionar</Button>}
  </div>;
}
