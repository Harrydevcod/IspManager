import { Badge } from '../../components';
import type { describeSource } from './iptv-api';

/** A origem curta à vista; a frase completa (quando há) fica no hover. */
export function SourceText({ source }: { source: ReturnType<typeof describeSource> }) {
  const hint = source.detail ?? undefined;
  if (source.tone === 'warn') return <span className={hint ? 'has-hint' : undefined} title={hint}><Badge tone="warn">{source.text}</Badge></span>;
  return <span className={hint ? 'has-hint' : undefined} title={hint}>{source.text}</span>;
}
