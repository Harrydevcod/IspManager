import {
  ArrowLeft,
  ArrowRightLeft,
  Cable,
  ChevronLeft,
  ChevronRight,
  Link2,
  Map,
  Pencil,
  RadioTower,
  Search,
  Unlink
} from 'lucide-react';
import type {
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackbonePage,
  BackboneStatus
} from '../../../shared/backbone';
import { Badge, Button, Field } from '../../components';
import { statusLabel, statusTone } from '../../lib/status';

const STATUS_LABEL: Record<BackboneStatus, string> = {
  active: 'Ativo',
  maintenance: 'Em manutenção',
  retired: 'Retirado'
};

function fact(value: string | null): string {
  return value?.trim() || 'Não informado';
}

function assignmentIdentity(assignment: BackboneAssignmentSummary): string {
  return assignment.serialNumber || assignment.assetTag || 'Não informado';
}

type BackboneDetailProps = {
  backbone: BackboneDeviceDetail | null;
  linked: BackbonePage<BackboneAssignmentSummary>;
  linkedQuery: string;
  linkedLoading: boolean;
  linkedError: string | null;
  selectedId: number | null;
  canManage: boolean;
  loading: boolean;
  onBack: () => void;
  onEdit: () => void;
  onLink: () => void;
  onTransfer: (assignment: BackboneAssignmentSummary) => void;
  onUnlink: (assignment: BackboneAssignmentSummary) => void;
  onViewTopology: (id: number) => void;
  onSelectDownstream: (id: number) => void;
  onLinkedQueryChange: (query: string) => void;
  onLinkedPageChange: (page: number) => void;
  onLinkedRetry: () => void;
};

export function BackboneDetail({
  backbone,
  linked,
  linkedQuery,
  linkedLoading,
  linkedError,
  selectedId,
  canManage,
  loading,
  onBack,
  onEdit,
  onLink,
  onTransfer,
  onUnlink,
  onViewTopology,
  onSelectDownstream,
  onLinkedQueryChange,
  onLinkedPageChange,
  onLinkedRetry
}: BackboneDetailProps) {
  if (selectedId === null) {
    return (
      <section className="backbone-detail backbone-detail-empty" aria-label="Detalhe do backbone">
        <span className="backbone-detail-mark" aria-hidden><RadioTower size={24} /></span>
        <p className="backbone-kicker">Inventário físico</p>
        <h3>Escolha um backbone</h3>
        <p>A identidade, localização e ligações aparecem aqui sem inferir conectividade.</p>
      </section>
    );
  }

  if (!backbone) {
    return (
      <section className="backbone-detail backbone-detail-empty" aria-label="Detalhe do backbone">
        <Button variant="ghost" className="backbone-mobile-back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden /> Voltar
        </Button>
        <span className="backbone-pulse" aria-hidden />
        <p role="status">{loading ? 'A carregar detalhe…' : 'A atualizar detalhe…'}</p>
      </section>
    );
  }

  return (
    <section className="backbone-detail" aria-labelledby={`backbone-detail-${backbone.id}`}>
      <Button variant="ghost" className="backbone-mobile-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden /> Voltar
      </Button>

      <header className="backbone-detail-header">
        <div>
          <p className="backbone-kicker">Unidade física · #{backbone.id}</p>
          <h3 id={`backbone-detail-${backbone.id}`} tabIndex={-1}>{backbone.name}</h3>
          <p>{[backbone.catalogBrand, backbone.catalogModel].filter(Boolean).join(' ')}</p>
        </div>
        <div className="backbone-detail-badges">
          {backbone.provisional && <Badge tone="accent">Provisório</Badge>}
          <Badge tone={backbone.status === 'active' ? 'success' : 'neutral'}>
            {STATUS_LABEL[backbone.status]}
          </Badge>
        </div>
      </header>

      <div className="backbone-detail-actions">
        {backbone.status === 'retired' ? (
          <p className="backbone-detail-note" role="status">
            Retirado — não aparece na topologia ativa
          </p>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Map size={15} aria-hidden />}
            onClick={() => onViewTopology(backbone.id)}
          >
            Ver na Topologia
          </Button>
        )}
        {canManage && (
          <>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<Pencil size={14} aria-hidden />}
              onClick={onEdit}
            >
              Editar
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<Link2 size={14} aria-hidden />}
              onClick={onLink}
            >
              Ligar equipamentos
            </Button>
          </>
        )}
      </div>

      <div className="backbone-facts">
        <section aria-labelledby="backbone-identity-title">
          <div className="backbone-section-heading">
            <span>01</span>
            <h4 id="backbone-identity-title">Identidade</h4>
          </div>
          <dl>
            <div><dt>Número de série</dt><dd>{fact(backbone.serialNumber)}</dd></div>
            <div><dt>Etiqueta patrimonial</dt><dd>{fact(backbone.assetTag)}</dd></div>
            <div><dt>Endereço IP</dt><dd>{fact(backbone.ipAddress)}</dd></div>
            <div><dt>Endereço MAC</dt><dd>{fact(backbone.macAddress)}</dd></div>
          </dl>
        </section>

        <section aria-labelledby="backbone-location-title">
          <div className="backbone-section-heading">
            <span>02</span>
            <h4 id="backbone-location-title">Implantação</h4>
          </div>
          <dl>
            <div><dt>Alimentado por</dt><dd>{backbone.upstreamName ?? 'Internet'}</dd></div>
            <div><dt>Ilha</dt><dd>{fact(backbone.island)}</dd></div>
            <div><dt>Zona</dt><dd>{fact(backbone.zone)}</dd></div>
            <div className="backbone-fact-wide"><dt>Notas</dt><dd>{fact(backbone.notes)}</dd></div>
          </dl>
        </section>
      </div>

      {backbone.downstream.length > 0 && (
        <section className="backbone-downstream" aria-labelledby="backbone-downstream-title">
          <div className="backbone-section-heading">
            <span>03</span>
            <h4 id="backbone-downstream-title">Alimenta</h4>
            <strong>{backbone.downstream.length}</strong>
          </div>
          <div className="backbone-downstream-list">
            {backbone.downstream.map((unit) => (
              <Button
                variant="ghost"
                className="backbone-downstream-row"
                key={unit.id}
                onClick={() => onSelectDownstream(unit.id)}
              >
                <span>
                  <strong>{unit.name}</strong>
                  <small>{[unit.catalogBrand, unit.catalogModel].filter(Boolean).join(' ')}</small>
                </span>
                <span className="backbone-downstream-state">
                  <Badge tone={unit.status === 'active' ? 'success' : 'neutral'}>
                    {STATUS_LABEL[unit.status]}
                  </Badge>
                  <small>{unit.linkedAssignmentCount} CPE</small>
                </span>
              </Button>
            ))}
          </div>
        </section>
      )}

      <section
        className="backbone-links"
        aria-labelledby="backbone-links-title"
        aria-busy={linkedLoading || undefined}
      >
        <div className="backbone-section-heading">
          <span>{backbone.downstream.length > 0 ? '04' : '03'}</span>
          <h4 id="backbone-links-title">Equipamentos ligados</h4>
          <strong>{backbone.linkedAssignmentCount}</strong>
        </div>

        <div className="backbone-linked-tools">
          <div className="backbone-search">
            <Search size={15} aria-hidden />
            <Field
              hideLabel
              aria-label="Pesquisar equipamentos ligados"
              label="Pesquisar equipamentos ligados"
              value={linkedQuery}
              onChange={(event) => onLinkedQueryChange(event.target.value)}
              placeholder="Cliente, código, série, IP ou MAC…"
            />
          </div>
        </div>

        {linkedError && linked.items.length > 0 && (
          <div className="backbone-links-state" role="alert">
            <strong>Não foi possível atualizar as ligações.</strong>
            <span>{linkedError}</span>
            <Button variant="secondary" size="sm" onClick={onLinkedRetry}>Tentar novamente</Button>
          </div>
        )}

        {linkedLoading && linked.items.length === 0 ? (
          <div className="backbone-links-state" role="status" aria-busy="true">
            <span className="backbone-pulse" aria-hidden />
            A carregar equipamentos ligados…
          </div>
        ) : linkedError && linked.items.length === 0 ? (
          <div className="backbone-links-state" role="alert">
            <strong>Não foi possível carregar as ligações.</strong>
            <span>{linkedError}</span>
            <Button variant="secondary" size="sm" onClick={onLinkedRetry}>Tentar novamente</Button>
          </div>
        ) : linked.items.length === 0 ? (
          <div className="backbone-links-empty">
            <Cable size={18} aria-hidden />
            <div>
              <strong>{linkedQuery ? 'Nenhuma ligação corresponde à pesquisa' : 'Sem CPE diretamente ligadas'}</strong>
              {/* Uma unidade de trânsito não tem CPE por desenho; dizer
                  "ainda não tem" fazia parecer configuração em falta. */}
              <p>
                {linkedQuery
                  ? 'Ajuste os termos pesquisados.'
                  : backbone.downstream.length > 0
                    ? 'As CPE dos clientes penduram nas unidades a jusante.'
                    : 'Esta unidade ainda não tem CPEs associados.'}
              </p>
            </div>
            {canManage && <Button variant="secondary" size="sm" onClick={onLink}>Criar ligação</Button>}
          </div>
        ) : (
          <div className="backbone-assignment-list">
            {linked.items.map((assignment) => (
              <article className="backbone-assignment" key={assignment.id}>
                <div className="backbone-assignment-main">
                  <span className="backbone-assignment-client">
                    <strong>{assignment.clientName}</strong>
                    <small>{assignment.clientCode} · Serviço #{assignment.serviceId}</small>
                  </span>
                  <span>
                    <strong>{[assignment.catalogBrand, assignment.catalogModel].filter(Boolean).join(' ')}</strong>
                    <small>{assignmentIdentity(assignment)} · IP {fact(assignment.ipAddress)}</small>
                  </span>
                </div>
                <div className="backbone-assignment-state">
                  <Badge tone={statusTone(assignment.serviceStatus)}>
                    Serviço {statusLabel(assignment.serviceStatus).toLowerCase()}
                  </Badge>
                  {canManage && (
                    <span className="backbone-assignment-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        leadingIcon={<ArrowRightLeft size={13} aria-hidden />}
                        onClick={() => onTransfer(assignment)}
                      >
                        Transferir
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        leadingIcon={<Unlink size={13} aria-hidden />}
                        onClick={() => onUnlink(assignment)}
                      >
                        Desligar
                      </Button>
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        <nav className="backbone-linked-pagination" aria-label="Paginação de equipamentos ligados">
          <span>Página {linked.page} de {Math.max(linked.totalPages, 1)}</span>
          <div>
            <Button
              variant="icon"
              size="sm"
              aria-label="Página anterior de equipamentos ligados"
              disabled={linked.page <= 1 || linkedLoading}
              onClick={() => onLinkedPageChange(linked.page - 1)}
            >
              <ChevronLeft size={15} aria-hidden />
            </Button>
            <Button
              variant="icon"
              size="sm"
              aria-label="Página seguinte de equipamentos ligados"
              disabled={linked.page >= linked.totalPages || linkedLoading}
              onClick={() => onLinkedPageChange(linked.page + 1)}
            >
              <ChevronRight size={15} aria-hidden />
            </Button>
          </div>
        </nav>
      </section>
    </section>
  );
}
