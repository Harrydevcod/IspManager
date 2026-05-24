import { useId, type SelectHTMLAttributes } from 'react';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  error?: string;
  hint?: string;
  wide?: boolean;
};

/** Labelled select control. Reuses the `.field` shell from `Field` when `label` is provided. */
export function Select({ label, error, hint, wide, id, className, children, ...rest }: SelectProps) {
  const reactId = useId();
  const selectId = id ?? `select-${reactId}`;
  const errorId = `${selectId}-error`;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const describedBy = error ? errorId : hintId;

  const select = (
    <select
      id={selectId}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      {...rest}
    >
      {children}
    </select>
  );

  if (!label) return select;

  const classes = ['field'];
  if (wide) classes.push('wide-field');
  if (className) classes.push(className);

  return (
    <label className={classes.join(' ')} htmlFor={selectId}>
      <span className="field-label">{label}</span>
      {select}
      {hint && !error ? <span id={hintId} className="field-hint">{hint}</span> : null}
      {error ? <span id={errorId} className="field-error">{error}</span> : null}
    </label>
  );
}
