import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
type Size = 'sm' | 'md' | 'lg';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn-${variant}`];
  if (size !== 'md') classes.push(`btn-${size}`);
  if (loading) classes.push('btn-loading');
  if (className) classes.push(className);

  return (
    <button
      type={type}
      className={classes.join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="btn-spinner" aria-hidden /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}
