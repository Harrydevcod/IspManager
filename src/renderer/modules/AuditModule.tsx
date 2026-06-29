import { Activity, Banknote, Inbox, KeyRound, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, ErrorRetry, Field, FilterBar, Select, SkeletonList } from '../components';
import { authFetch } from '../lib/auth';
import { formatPtDate, formatPtDateTime } from '../lib/format';
import './AuditModule.css';

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

type EventTone = 'success' | 'danger' | 'info' | 'neutral' | 'accent';

const PAGE_SIZE = 25;

function iconFor(action: string): LucideIcon {
  if (action.includes('delete') || action.includes('cancel')) return Trash2;
  if (action.includes('restore')) return RotateCcw;
  if (action.includes('pay')) return Banknote;
  if (action.includes('create')) return Plus;
  if (action.includes('password')) return KeyRound;
  if (action.includes('update')) return Pencil;
  return Activity;
}

function toneFor(action: string): EventTone {
  if (action.includes('delete') || action.includes('cancel') || action.includes('restore')) return 'danger';
  if (action.includes('create') || action.includes('pay')) return 'success';
  if (action.includes('password')) return 'accent';
  if (action.includes('update')) return 'info';
  return 'neutral';
}

function parseDate(iso: string): Date | null {
  const d = new Date(iso.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function relativeTime(iso: string): string {
  const d = parseDate(iso);
  if (!d) return iso;
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return 'agora';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin}min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `há ${diffD}d`;
  return formatPtDate(iso);
}

function absoluteTime(iso: string): string {
  return formatPtDateTime(iso);
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
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
        setLoadError(null);
      })
      .catch(() => {
        setRows([]);
        setTotal(0);
        setTotalPages(1);
        setLoadError('Não foi possível carregar a auditoria.');
      })
      .finally(() => setLoading(false));
  }, [page, entityFilter, dateFrom, dateTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);
  const hasFilter = entityFilter !== 'all' || !!dateFrom || !!dateTo;

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Administracao</p>
          <h2>Auditoria</h2>
          <p className="audit-header-subtitle">
            <strong>{total.toLocaleString('pt-PT')}</strong>{' '}
            {hasFilter ? 'eventos nos filtros atuais' : 'eventos registados'}
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>
          Atualizar
        </Button>
      </div>

      <div className="audit-filter-sticky">
        <FilterBar>
          <Select
            label="Entidade"
            value={entityFilter}
            onChange={(event) => { setEntityFilter(event.target.value); setPage(1); }}
          >
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
          <Button
            variant="secondary"
            onClick={() => { setEntityFilter('all'); setDateFrom(''); setDateTo(''); setPage(1); }}
          >
            Limpar filtros
          </Button>
          <small>{showingFrom}-{showingTo} de {total}</small>
        </FilterBar>
      </div>

      {loading && <SkeletonList rows={6} />}
      {loadError && !loading && <ErrorRetry message={loadError} onRetry={() => { void load(); }} />}

      {!loading && rows.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="Sem eventos de auditoria"
          description="Ainda não há registos. Ações sobre clientes, planos e faturação aparecem aqui assim que ocorrerem."
        />
      )}

      {!loading && rows.length > 0 && (
        <>
          <div className="audit-feed" role="list">
            {rows.map((row) => {
              const Icon = iconFor(row.action);
              const tone = toneFor(row.action);
              return (
                <div className="audit-entry" role="listitem" key={row.id}>
                  <time
                    className="audit-entry-time"
                    dateTime={row.createdAt}
                    title={absoluteTime(row.createdAt)}
                  >
                    {relativeTime(row.createdAt)}
                  </time>
                  <span className="audit-entry-icon" data-tone={tone} aria-hidden>
                    <Icon size={12} strokeWidth={2} />
                  </span>
                  <div className="audit-entry-event">
                    <strong>{row.summary || `${row.action} ${row.entityType}`}</strong>
                    <span className="audit-entry-event-meta">
                      <span className="audit-action">{row.action}</span>
                      <span className="audit-action-sep">·</span>
                      <span>{row.entityType}{row.entityId ? ` #${row.entityId}` : ''}</span>
                    </span>
                  </div>
                  <div className="audit-entry-actor">
                    <span className="audit-entry-actor-name">
                      {row.actorUsername ? `@${row.actorUsername}` : 'sistema'}
                    </span>
                    {row.actorRole && <span className="audit-entry-actor-id">{row.actorRole}</span>}
                  </div>
                </div>
              );
            })}
          </div>

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
        </>
      )}
    </section>
  );
}
