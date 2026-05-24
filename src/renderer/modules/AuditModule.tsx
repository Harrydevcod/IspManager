import { Inbox } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Field, FilterBar, Message, Select } from '../components';
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

type AuditLogPage = {
  rows: AuditLogRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  entities: string[];
};

const PAGE_SIZE = 25;

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
  const [entities, setEntities] = useState<string[]>([]);
  const [entityFilter, setEntityFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE)
    });
    if (entityFilter !== 'all') params.set('entityType', entityFilter);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    return authFetch(`http://127.0.0.1:3001/api/audit-logs?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error('audit unavailable');
        return response.json() as Promise<AuditLogPage>;
      })
      .then((data) => {
        setRows(data.rows);
        setEntities(data.entities);
        setTotal(data.total);
        setTotalPages(data.totalPages);
        if (data.page !== page) setPage(data.page);
      })
      .catch(() => {
        setRows([]);
        setTotal(0);
        setTotalPages(1);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, [entityFilter, dateFrom, dateTo, page]);

  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Administracao</p>
          <h2>Auditoria</h2>
        </div>
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>
          Atualizar
        </Button>
      </div>

      <FilterBar>
        <Select label="Entidade" value={entityFilter} onChange={(event) => { setEntityFilter(event.target.value); setPage(1); }}>
          <option value="all">Todas</option>
          {entities.map((entity) => (
            <option key={entity} value={entity}>{entity}</option>
          ))}
        </Select>
        <Field
          label="De"
          type="date"
          value={dateFrom}
          onChange={(event) => { setDateFrom(event.target.value); setPage(1); }}
        />
        <Field
          label="Ate"
          type="date"
          value={dateTo}
          onChange={(event) => { setDateTo(event.target.value); setPage(1); }}
        />
        <Button variant="secondary" onClick={() => { setEntityFilter('all'); setDateFrom(''); setDateTo(''); setPage(1); }}>
          Limpar filtros
        </Button>
        <small>{showingFrom}-{showingTo} de {total} eventos</small>
      </FilterBar>

      {loading && <Message>A carregar auditoria...</Message>}
      {!loading && (
        <div className="module-table">
          {rows.map((row) => (
            <div className="module-row audit-row" key={row.id}>
              <span className="audit-row-main">
                <strong>{row.summary || `${row.action} ${row.entityType}`}</strong>
                <small>
                  {row.actorUsername ? `@${row.actorUsername}` : 'sistema'} · {formatAuditDate(row.createdAt)}
                </small>
              </span>
              <Badge tone={toneFor(row.action)}>{row.action}</Badge>
              <small className="audit-row-entity">{row.entityType}{row.entityId ? ` #${row.entityId}` : ''}</small>
            </div>
          ))}
          {rows.length === 0 && (
            <EmptyState
              icon={Inbox}
              title="Sem eventos de auditoria"
              description="Ainda não há registos. Ações sobre clientes, planos e faturação aparecem aqui assim que ocorrerem."
            />
          )}
          {total > PAGE_SIZE && (
            <div className="audit-pagination" aria-label="Paginacao da auditoria">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                Anterior
              </Button>
              <span>Pagina {page} de {totalPages}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                Proxima
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
