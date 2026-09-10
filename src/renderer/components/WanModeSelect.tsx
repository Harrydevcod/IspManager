import { useState } from 'react';
import { Button } from './Button';
import { Field } from './Field';
import { Select } from './Select';
import { WAN_MODES, WAN_MODE_LABELS, isKnownWanMode } from '../../shared/wan';

const OTHER_OPTION = '__outro__';

type WanModeSelectProps = {
  /** Vazio = por classificar. Um valor fora da lista é uma etiqueta escrita à mão. */
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hideLabel?: boolean;
  /** Nome acessível quando o label sozinho não distingue — listas com um campo por linha. */
  ariaLabel?: string;
  hint?: string;
};

/**
 * Como é que esta unidade obtém endereço.
 *
 * Lista com escape: os predefinidos vivem em `shared/wan.ts` e o terreno pode
 * escrever o que faltar, exatamente como o tipo de equipamento no Stock. Um modo
 * escrito à mão é só uma etiqueta — não pinta o mapa nem obriga a IP.
 *
 * Deixar em branco é legítimo e diz-se "por classificar": o parque anterior à
 * migração 0056 nasceu assim e classifica-se ao ritmo do terreno.
 */
export function WanModeSelect({
  value, onChange, label = 'Ligação', hideLabel, ariaLabel, hint
}: WanModeSelectProps) {
  const isFreeText = Boolean(value) && !isKnownWanMode(value);
  const [writing, setWriting] = useState(isFreeText);

  if (writing) {
    return (
      <div className="wan-mode-free">
        <Field
          label={label}
          hideLabel={hideLabel}
          aria-label={ariaLabel}
          value={value}
          placeholder="ex.: IPv6 nativo"
          hint={hint}
          maxLength={40}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          variant="ghost"
          type="button"
          onClick={() => { setWriting(false); onChange(''); }}
        >
          Escolher da lista
        </Button>
      </div>
    );
  }

  return (
    <Select
      label={label}
      hideLabel={hideLabel}
      aria-label={ariaLabel}
      hint={hint}
      value={value}
      onChange={(event) => {
        if (event.target.value === OTHER_OPTION) {
          setWriting(true);
          onChange('');
          return;
        }
        onChange(event.target.value);
      }}
    >
      <option value="">Por classificar</option>
      {WAN_MODES.map((mode) => (
        <option key={mode} value={mode}>{WAN_MODE_LABELS[mode]}</option>
      ))}
      <option value={OTHER_OPTION}>+ Outro modo…</option>
    </Select>
  );
}
