import type { ReactNode } from 'react';

type MessageProps = { tone?: 'error' | 'success' | 'neutral'; children: ReactNode };

/**
 * Inline status message.
 * Source of truth: Dashboard / PaymentsModule `<p className="module-message">`
 * (neutral) and `<p className="module-message error">` (error).
 */
export function Message({ tone = 'neutral', children }: MessageProps) {
  const cls = tone === 'neutral' ? 'module-message' : `module-message ${tone}`;
  return <p className={cls}>{children}</p>;
}
