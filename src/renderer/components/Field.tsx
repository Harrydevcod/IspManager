import { useId, type InputHTMLAttributes } from 'react';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
  wide?: boolean;
  /**
   * Mantém o label só para leitores de ecrã. Para colunas de tabela, onde o
   * cabeçalho já nomeia o campo e repetir o label em cada linha é ruído.
   */
  hideLabel?: boolean;
};

/** Labelled input with optional hint caption + inline error. */
export function Field({ label, error, hint, wide, hideLabel, id, className, ...rest }: FieldProps) {
  const reactId = useId();
  const inputId = id ?? `field-${reactId}`;
  const errorId = `${inputId}-error`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const describedBy = error ? errorId : hintId;

  const classes = ['field'];
  if (wide) classes.push('wide-field');
  if (className) classes.push(className);

  return (
    <label className={classes.join(' ')} htmlFor={inputId}>
      <span className={hideLabel ? 'sr-only' : 'field-label'}>{label}</span>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && !error ? <span id={hintId} className="field-hint">{hint}</span> : null}
      {error ? <span id={errorId} className="field-error">{error}</span> : null}
    </label>
  );
}
