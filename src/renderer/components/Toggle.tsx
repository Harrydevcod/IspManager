import { useId, type InputHTMLAttributes } from 'react';

type ToggleProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  title: string;
  description?: string;
  wide?: boolean;
};

/** Checkbox with adjacent title + optional description caption. Settings-style toggle. */
export function Toggle({ title, description, wide = true, id, className, ...rest }: ToggleProps) {
  const reactId = useId();
  const inputId = id ?? `toggle-${reactId}`;

  const classes = ['field-toggle'];
  if (wide) classes.push('wide-field');
  if (className) classes.push(className);

  return (
    <label className={classes.join(' ')} htmlFor={inputId}>
      <input id={inputId} type="checkbox" {...rest} />
      <span>
        <strong>{title}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}
