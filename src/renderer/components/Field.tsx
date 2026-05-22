import type { InputHTMLAttributes } from 'react';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string };

/**
 * Labelled input. The slice uses bare `<label>Text <input/></label>`
 * (e.g. the payments filter bar). No `field`/`field-label`/`field-error`
 * classes exist, so they are added additively to styles.css (token-based).
 */
export function Field({ label, error, id, ...rest }: FieldProps) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input id={id} aria-invalid={error ? true : undefined} {...rest} />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}
