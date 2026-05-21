import type { SelectHTMLAttributes } from 'react';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: string };

/**
 * Select control. The slice wraps selects in bare
 * `<label>Estado <select>…</select></label>`. When `label` is provided we
 * reuse the same `.field`/`.field-label` primitives as `Field` (added
 * additively to styles.css); otherwise the raw `<select>` is returned.
 */
export function Select({ label, children, ...rest }: SelectProps) {
  const el = <select {...rest}>{children}</select>;
  return label ? (
    <label className="field">
      <span className="field-label">{label}</span>
      {el}
    </label>
  ) : (
    el
  );
}
