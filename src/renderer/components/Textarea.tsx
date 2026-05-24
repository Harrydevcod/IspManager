import { useId, type TextareaHTMLAttributes } from 'react';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string;
  hint?: string;
  wide?: boolean;
};

/** Labelled textarea, parallel to `Field`. Defaults to `wide` because textareas usually span the full form row. */
export function Textarea({ label, error, hint, wide = true, id, className, ...rest }: TextareaProps) {
  const reactId = useId();
  const textareaId = id ?? `textarea-${reactId}`;
  const errorId = `${textareaId}-error`;
  const hintId = hint ? `${textareaId}-hint` : undefined;
  const describedBy = error ? errorId : hintId;

  const classes = ['field'];
  if (wide) classes.push('wide-field');
  if (className) classes.push(className);

  return (
    <label className={classes.join(' ')} htmlFor={textareaId}>
      <span className="field-label">{label}</span>
      <textarea
        id={textareaId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && !error ? <span id={hintId} className="field-hint">{hint}</span> : null}
      {error ? <span id={errorId} className="field-error">{error}</span> : null}
    </label>
  );
}
