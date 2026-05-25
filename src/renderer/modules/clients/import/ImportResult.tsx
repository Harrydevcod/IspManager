import { CheckCircle2 } from 'lucide-react';
import type { BulkResult } from './types';

/** Final step: summary figure + per-bucket counts + collapsible per-error list. */
export function ImportResult({ result }: { result: BulkResult }) {
  return (
    <div className="import-result">
      <div className="import-result-figure">
        <CheckCircle2 size={32} strokeWidth={1.4} aria-hidden />
        <strong>{result.summary.inserted}</strong>
        <span>cliente(s) importado(s)</span>
      </div>
      <dl className="import-result-grid">
        <div>
          <dt>Recebidos</dt>
          <dd>{result.summary.received}</dd>
        </div>
        <div>
          <dt>Inseridos</dt>
          <dd>{result.summary.inserted}</dd>
        </div>
        <div>
          <dt>Ignorados (duplicados)</dt>
          <dd>{result.summary.skipped}</dd>
        </div>
        <div>
          <dt>Com erro</dt>
          <dd>{result.summary.errors}</dd>
        </div>
      </dl>
      {result.errors.length > 0 && (
        <details className="import-result-detail">
          <summary>Ver erros ({result.errors.length})</summary>
          <ul>
            {result.errors.map((err, i) => (
              <li key={i}>linha {err.index + 1}: {err.detail || err.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
