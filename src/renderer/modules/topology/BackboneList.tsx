import { ChevronLeft, ChevronRight, RadioTower, Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { BackboneDeviceSummary, BackbonePage, BackboneStatus } from '../../../shared/backbone';
import { Badge, Button, Field, Select } from '../../components';

const STATUS_LABEL: Record<BackboneStatus, string> = {
  active: 'Ativo',
  maintenance: 'Em manutenção',
  retired: 'Retirado'
};

function identity(backbone: BackboneDeviceSummary): string {
  return backbone.serialNumber || backbone.assetTag || 'Identidade não informada';
}

function location(backbone: BackboneDeviceSummary): string {
  return [backbone.island, backbone.zone].filter(Boolean).join(' · ') || 'Local não informado';
}

export type BackboneListProps = {
  page: BackbonePage<BackboneDeviceSummary>;
  selectedId: number | null;
  query: string;
  status: BackboneStatus | undefined;
  loading: boolean;
  error: string | null;
  unlinkedCount: number;
  onQueryChange: (query: string) => void;
  onStatusChange: (status: BackboneStatus | undefined) => void;
  onPageChange: (page: number) => void;
  onSelect: (id: number) => void;
  onRetry: () => void;
};

export function BackboneList({
  page,
  selectedId,
  query,
  status,
  loading,
  error,
  unlinkedCount,
  onQueryChange,
  onStatusChange,
  onPageChange,
  onSelect,
  onRetry
}: BackboneListProps) {
  function handleRowKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    backboneId: number
  ) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(backboneId);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = [...event.currentTarget.closest('[role="listbox"]')!
      .querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const target = event.key === 'ArrowDown' ? rows[index + 1] : rows[index - 1];
    target?.focus();
  }

  return (
    <aside className="backbone-list" aria-label="Backbones registados">
      <div className="backbone-list-tools">
        <div className="backbone-search">
          <Search size={15} aria-hidden />
          <Field
            hideLabel
            label="Pesquisar backbones"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Nome, IP, série ou ativo…"
          />
        </div>
        <Select
          aria-label="Filtrar por estado"
          value={status ?? 'all'}
          onChange={(event) => onStatusChange(
            event.target.value === 'all' ? undefined : event.target.value as BackboneStatus
          )}
        >
          <option value="all">Todos os estados</option>
          <option value="active">Ativos</option>
          <option value="maintenance">Em manutenção</option>
          <option value="retired">Retirados</option>
        </Select>
      </div>

      <div className="backbone-list-summary" aria-live="polite">
        <span><strong>{page.total}</strong> registados</span>
        {/* Antenas e CPE à espera de backbone. O router do cliente nunca entra
            nesta conta: pende da antena dele, não daqui. */}
        <span className="backbone-unlinked-count"><strong>{unlinkedCount}</strong> por ligar</span>
      </div>

      <div className="backbone-list-scroll">
        {loading && page.items.length === 0 ? (
          <div className="backbone-list-state" role="status">
            <span className="backbone-pulse" aria-hidden />
            A carregar inventário…
          </div>
        ) : error && page.items.length === 0 ? (
          <div className="backbone-list-state" role="alert">
            <strong>Não foi possível carregar.</strong>
            <span>{error}</span>
            <Button variant="secondary" size="sm" onClick={onRetry}>Tentar novamente</Button>
          </div>
        ) : page.items.length === 0 ? (
          <div className="backbone-list-state">
            <RadioTower size={20} aria-hidden />
            <strong>{query || status ? 'Nenhum resultado' : 'Nenhum backbone registado'}</strong>
            <span>{query || status
              ? 'Ajuste a pesquisa ou o estado.'
              : 'Registe a primeira unidade física para começar.'}</span>
          </div>
        ) : (
          <div role="listbox" aria-label="Lista de backbones" aria-busy={loading || undefined}>
            {page.items.map((backbone, index) => (
              <Button
                key={backbone.id}
                variant="ghost"
                role="option"
                data-backbone-id={backbone.id}
                aria-selected={selectedId === backbone.id}
                className="backbone-row"
                onClick={() => onSelect(backbone.id)}
                onKeyDown={(event) => handleRowKeyDown(event, index, backbone.id)}
              >
                <span className="backbone-row-primary">
                  <span>
                    <strong>{backbone.name}</strong>
                    {backbone.provisional && <Badge tone="accent">Provisório</Badge>}
                  </span>
                  <Badge tone={backbone.status === 'active' ? 'success' : 'neutral'}>
                    {STATUS_LABEL[backbone.status]}
                  </Badge>
                </span>
                <span className="backbone-row-model">
                  {[backbone.catalogBrand, backbone.catalogModel].filter(Boolean).join(' ')}
                </span>
                <span className="backbone-row-meta">
                  <span>{identity(backbone)}</span>
                  {backbone.ipAddress && <span>IP {backbone.ipAddress}</span>}
                  <span>{location(backbone)}</span>
                  <span>
                    {backbone.linkedAssignmentCount}
                    {backbone.linkedAssignmentCount === 1 ? ' ligado' : ' ligados'}
                  </span>
                  {/* Sem isto, uma unidade que só alimenta outras lê-se vazia. */}
                  {backbone.downstreamCount > 0 && (
                    <span>{backbone.downstreamCount} a jusante</span>
                  )}
                </span>
              </Button>
            ))}
          </div>
        )}
      </div>

      <nav className="backbone-pagination" aria-label="Paginação de backbones">
        <span>Página {page.page} de {Math.max(page.totalPages, 1)}</span>
        <div>
          <Button
            variant="icon"
            size="sm"
            aria-label="Página anterior"
            disabled={page.page <= 1 || loading}
            onClick={() => onPageChange(page.page - 1)}
          >
            <ChevronLeft size={15} aria-hidden />
          </Button>
          <Button
            variant="icon"
            size="sm"
            aria-label="Página seguinte"
            disabled={page.page >= page.totalPages || loading}
            onClick={() => onPageChange(page.page + 1)}
          >
            <ChevronRight size={15} aria-hidden />
          </Button>
        </div>
      </nav>
    </aside>
  );
}
