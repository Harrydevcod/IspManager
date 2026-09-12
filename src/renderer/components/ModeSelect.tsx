import { useState } from 'react';
import { Button } from './Button';
import { Field } from './Field';
import { Select } from './Select';

const OTHER_OPTION = '__outro__';

export type ModeSelectProps = {
  /** Vazio = por classificar. Um valor fora da lista é uma etiqueta escrita à mão. */
  value: string;
  onChange: (value: string) => void;
  /** Sobrepõe o rótulo da configuração — raro; o nome do eixo costuma bastar. */
  label?: string;
  hideLabel?: boolean;
  /** Nome acessível quando o label sozinho não distingue — listas com um campo por linha. */
  ariaLabel?: string;
  hint?: string;
  /**
   * Que modos oferecer aqui, por esta ordem. Por omissão, os da configuração.
   *
   * Estreitar o que se oferece não estreita o que se conhece: um modo gravado
   * fora desta lista continua a ser um modo (rotulado, não texto livre).
   */
  modes?: readonly string[];
};

type ModeSelectConfig = {
  modes: readonly string[];
  labels: Record<string, string>;
  /** O nome do eixo: "Ligação" ou "Operação". */
  label: string;
  /** Texto da opção de escape e placeholder do campo livre. */
  otherLabel: string;
  freePlaceholder: string;
};

/**
 * Um campo de modo: lista com escape para texto livre.
 *
 * Serve os dois eixos que o equipamento tem — como obtém endereço (`wan.ts`) e
 * que papel desempenha (`operation.ts`). Ambos seguem o mesmo contrato do tipo
 * de equipamento desde a 0047: os predefinidos são sugestões, o terreno escreve
 * o que faltar, e o que se escreve à mão é só uma etiqueta.
 *
 * Deixar em branco é legítimo e diz-se "por classificar": o parque anterior a
 * cada campo nasceu assim e classifica-se ao ritmo do terreno.
 */
export function createModeSelect(config: ModeSelectConfig) {
  /** Está no registo do eixo — ou seja, não é uma etiqueta escrita à mão. */
  const isRegistered = (value: string) => config.modes.includes(value.trim().toLowerCase());

  return function ModeSelect({
    value, onChange, label = config.label, hideLabel, ariaLabel, hint, modes = config.modes
  }: ModeSelectProps) {
    const [writing, setWriting] = useState(Boolean(value) && !isRegistered(value));
    const isOffered = (candidate: string) => modes.includes(candidate.trim().toLowerCase());

    if (writing) {
      return (
        <div className="mode-select-free">
          <Field
            label={label}
            hideLabel={hideLabel}
            aria-label={ariaLabel}
            value={value}
            placeholder={config.freePlaceholder}
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
        {modes.map((mode) => (
          <option key={mode} value={mode}>{config.labels[mode]}</option>
        ))}
        {/* Um valor gravado fora da lista continua a aparecer: nada desaparece
            de um formulário só porque a lista mudou — nem porque este
            equipamento não é do tipo que costuma levar esse modo. Se é do
            registo, mostra-se com o rótulo; à mão, mostra-se à letra. */}
        {value && !isOffered(value) && (
          <option value={value}>{config.labels[value] ?? value}</option>
        )}
        <option value={OTHER_OPTION}>{config.otherLabel}</option>
      </Select>
    );
  };
}
