import { useId, type InputHTMLAttributes } from 'react';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string };

/**
 * Labelled input. The slice uses bare `<label>Text <input/></label>`
 * (e.g. the payments filter bar). No `field`/`field-label`/`field-error`
 * classes exist, so they are added additively to styles.css (token-based).
 */
export function Field({ label, error, id, ...rest }: FieldProps) {
  const reactId = useId();
  const inputId = id ?? `field-${reactId}`;
  const errorId = `${inputId}-error`;
  return (
    <label className="field" htmlFor={inputId}>
      <span className="field-label">{label}</span>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error ? <span id={errorId} className="field-error">{error}</span> : null}
    </label>
  );
}
