import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'ghost' | 'icon';
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };

/**
 * The polished slice uses bare `<button>` elements styled contextually
 * (`.inline-actions button`, `.payment-quick-actions button`). No `btn`
 * class exists, so `.btn`/`.btn-primary`/`.btn-ghost`/`.btn-icon` are added
 * additively to styles.css (token-based). Primary deliberately uses
 * `var(--accent)` as its background.
 */
export function Button({ variant = 'primary', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  );
}
