import { useEffect, useState } from 'react';
import { Badge } from '../components';
import { authFetch } from '../lib/auth';

type AuditLogRow = {
  id: number;
  actorUsername: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  createdAt: string;
};

function formatAuditDate(value: string): string {
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toneFor(action: string): 'success' | 'danger' | 'info' | 'neutral' | 'accent' {
  if (action.includes('delete') || action.includes('cancel') || action.includes('restore')) return 'danger';
  if (action.includes('create') || action.includes('pay')) return 'success';
  if (action.includes('password')) return 'accent';
  if (action.includes('update')) return 'info';
  return 'neutral';
}

export function AuditModule() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [entityFilter, setEntityFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    const query = entityFilter === 'all' ? '' : `?entityType=${encodeURIComponent(entityFilter)}`;
    return authFetch(`http://127.0.0.1:3001/api/audit-logs${query}`)
      .then((response) => {
        if (!response.ok) throw new Error('audit unavailable');
        return response.json() as Promise<AuditLogRow[]>;
      })
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, [entityFilter]);

  const entities = Array.from(new Set(rows.map((row) => row.entityType))).sort();

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Administracao</p>
          <h2>Auditoria</h2>
        </div>
        <button type="button" onClick={() => void load()}>Atualizar</button>
      </div>

      <div className="filter-bar">
        <label>
          Entidade
          <select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)}>
            <option value="all">Todas</option>
            {entities.map((entity) => (
              <option key={entity} value={entity}>{entity}</option>
            ))}
          </select>
        </label>
        <small>{rows.length} eventos</small>
      </div>

      {loading && <p className="module-message">A carregar auditoria...</p>}
      {!loading && (
        <div className="module-table">
          {rows.map((row) => (
            <div className="module-row" key={row.id}>
              <span>
                <strong>{row.summary || `${row.action} ${row.entityType}`}</strong>
                <small>
                  {row.actorUsername ? `@${row.actorUsername}` : 'sistema'} · {formatAuditDate(row.createdAt)}
                </small>
              </span>
              <Badge tone={toneFor(row.action)}>{row.action}</Badge>
              <small>{row.entityType}{row.entityId ? ` #${row.entityId}` : ''}</small>
            </div>
          ))}
          {rows.length === 0 && <p className="module-message">Sem eventos de auditoria.</p>}
        </div>
      )}
    </section>
  );
}
