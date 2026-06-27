import { Cable, Coins, History, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, Message } from '../../components';
import { formatCve, formatPtDate, formatPtDateTime } from '../../lib/format';
import { statusLabel, statusTone } from '../../lib/status';
import type { DeviceAssignment, ServiceEvent, ServiceEventType, ServiceRow, TechnicalHistory } from '../../types';

export const eventTypeLabel: Record<ServiceEventType, string> = {
  instalacao: 'Instalacao',
  manutencao: 'Manutencao',
  troca_equipamento: 'Troca de equipamento',
  visita: 'Visita tecnica',
  alteracao_servico: 'Alteracao de servico'
};

const eventTypeTone: Record<ServiceEventType, 'success' | 'info' | 'neutral' | 'accent'> = {
  instalacao: 'success',
  manutencao: 'info',
  troca_equipamento: 'info',
  visita: 'neutral',
  alteracao_servico: 'accent'
};

const INSTALL_COST_LABELS: Record<'mao_de_obra' | 'transporte' | 'outro', string> = {
  mao_de_obra: 'Mao de obra',
  transporte: 'Transporte',
  outro: 'Outro'
};

type ServiceDetailDialogProps = {
  service: ServiceRow;
  technicalHistory: TechnicalHistory | null;
  historyLoading: boolean;
  monthlyTotalCve: number;
  audiovisualLabel: string | undefined;
  canManage: boolean;
  canRecordTechnical: boolean;
  submitting: boolean;
  onClose: () => void;
  onEdit: (service: ServiceRow) => void;
  onDelete: (service: ServiceRow) => void;
  onAddDevice: () => void;
  onReplaceDevice: (assignment: DeviceAssignment) => void;
  onReturnDevice: (assignment: DeviceAssignment) => void;
  onAddEvent: () => void;
};

export function ServiceDetailDialog({
  service,
  technicalHistory,
  historyLoading,
  monthlyTotalCve,
  audiovisualLabel,
  canManage,
  canRecordTechnical,
  submitting,
  onClose,
  onEdit,
  onDelete,
  onAddDevice,
  onReplaceDevice,
  onReturnDevice,
  onAddEvent
}: ServiceDetailDialogProps) {
  return (
    <Dialog
      open
      size="xl"
      eyebrow="Servico"
      title={service.clientName}
      onClose={onClose}
      actions={
        canManage
          ? (
            <>
              <Button variant="secondary" size="sm" leadingIcon={<Pencil size={16} aria-hidden />} onClick={() => onEdit(service)}>
                Editar
              </Button>
              <Button variant="danger" size="sm" disabled={submitting} leadingIcon={<Trash2 size={16} aria-hidden />} onClick={() => onDelete(service)}>
                Apagar
              </Button>
            </>
          )
          : undefined
      }
    >
      <div className="client-detail">
      <dl>
        <div><dt>Plano</dt><dd>{service.planName || '-'}</dd></div>
        <div>
          <dt>Mensalidade</dt>
          <dd>
            {formatCve(monthlyTotalCve)}
            {service.audiovisualMode === 'monthly' && (
              <small className="muted"> (NET + TVM)</small>
            )}
          </dd>
        </div>
        {service.audiovisualMode !== 'none' && (
          <div>
            <dt>{audiovisualLabel || 'Conteúdos audiovisuais'}</dt>
            <dd>
              {service.audiovisualMode === 'monthly'
                ? `${formatCve(service.audiovisualMonthlyCve)} / mês (incluído na mensalidade)`
                : `${formatCve(service.audiovisualAnnualCve)} / ano (fatura separada)`}
            </dd>
          </div>
        )}
        <div><dt>Vencimento</dt><dd>Dia {service.dueDay}</dd></div>
        <div><dt>Ativado em</dt><dd>{formatPtDate(service.activationDate)}</dd></div>
        <div><dt>Estado</dt><dd><Badge tone={statusTone(service.status)}>{statusLabel(service.status)}</Badge></dd></div>
      </dl>

      <section className="technical-section">
        <header className="technical-section-head">
          <div>
            <p className="eyebrow"><Cable size={12} /> Equipamentos</p>
            <h3>
              {technicalHistory
                ? `${technicalHistory.assignments.filter((a) => !a.endDate).length} ativo(s) / ${technicalHistory.assignments.length} total`
                : 'A carregar...'}
            </h3>
          </div>
          {canRecordTechnical && (
            <Button variant="secondary" size="sm" className="technical-add" leadingIcon={<Plus size={14} aria-hidden />} onClick={onAddDevice}>
              Adicionar
            </Button>
          )}
        </header>
        {historyLoading && !technicalHistory && <Message>A carregar historico...</Message>}
        {technicalHistory && technicalHistory.assignments.length === 0 && (
          <EmptyState
            size="sm"
            icon={Cable}
            title="Sem equipamento atribuído"
            description="Atribui hardware a este serviço para começar a registar histórico técnico."
          />
        )}
        {technicalHistory && technicalHistory.assignments.length > 0 && (
          <ul className="technical-list">
            {technicalHistory.assignments.map((assignment: DeviceAssignment) => {
              const active = !assignment.endDate;
              return (
                <li key={assignment.id} className={active ? 'technical-item active' : 'technical-item past'}>
                  <div className="technical-item-head">
                    <strong>
                      {assignment.brand ? `${assignment.brand} ${assignment.model}` : assignment.model}
                      <span className="technical-item-type"> · {assignment.catalogType}</span>
                    </strong>
                    <Badge tone={active ? 'success' : 'neutral'}>{active ? 'Ativo' : 'Removido'}</Badge>
                  </div>
                  <dl className="technical-item-meta">
                    {assignment.serialNumber && <div><dt>Serial</dt><dd>{assignment.serialNumber}</dd></div>}
                    {assignment.macAddress && <div><dt>MAC</dt><dd>{assignment.macAddress}</dd></div>}
                    {assignment.ipAddress && <div><dt>IP</dt><dd>{assignment.ipAddress}</dd></div>}
                    {assignment.assetTag && <div><dt>Tag</dt><dd>{assignment.assetTag}</dd></div>}
                    <div><dt>Inicio</dt><dd>{formatPtDate(assignment.startDate)}</dd></div>
                    {assignment.endDate && <div><dt>Fim</dt><dd>{formatPtDate(assignment.endDate)}</dd></div>}
                  </dl>
                  {assignment.notes && <p className="technical-item-notes">{assignment.notes}</p>}
                  {active && canRecordTechnical && (
                    <div className="technical-item-actions">
                      <Button variant="secondary" size="sm" disabled={submitting} onClick={() => onReplaceDevice(assignment)}>
                        Substituir
                      </Button>
                      <Button variant="danger" size="sm" disabled={submitting} onClick={() => onReturnDevice(assignment)}>
                        Remover
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="technical-section">
        <header className="technical-section-head">
          <div>
            <p className="eyebrow"><Cable size={12} /> Materiais</p>
            <h3>{technicalHistory ? `${technicalHistory.materials.length} linha(s)` : 'A carregar...'}</h3>
          </div>
        </header>
        {technicalHistory && technicalHistory.materials.length === 0 && (
          <EmptyState
            size="sm"
            icon={Cable}
            title="Sem materiais registados"
            description="Materiais consumidos neste servico aparecem aqui."
          />
        )}
        {technicalHistory && technicalHistory.materials.length > 0 && (
          <ul className="technical-list">
            {technicalHistory.materials.map((material) => (
              <li key={material.id} className="technical-item active">
                <div className="technical-item-head">
                  <strong>{material.brand ? `${material.brand} ${material.model}` : material.model}</strong>
                  <Badge tone="neutral">{material.catalogType}</Badge>
                </div>
                <dl className="technical-item-meta">
                  <div><dt>Quantidade</dt><dd>{material.quantity} {material.unitOfMeasure}</dd></div>
                  <div><dt>Custo</dt><dd>{formatCve(material.unitCostCve * material.quantity)}</dd></div>
                  <div><dt>Registado</dt><dd>{formatPtDateTime(material.createdAt)}</dd></div>
                </dl>
                {material.notes && <p className="technical-item-notes">{material.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="technical-section">
        <header className="technical-section-head">
          <div>
            <p className="eyebrow"><Coins size={12} /> Custos de instalacao</p>
            <h3>
              {technicalHistory
                ? formatCve(technicalHistory.installCosts.reduce((sum, cost) => sum + cost.amountCve, 0))
                : 'A carregar...'}
            </h3>
          </div>
        </header>
        {technicalHistory && technicalHistory.installCosts.length === 0 && (
          <EmptyState
            size="sm"
            icon={Coins}
            title="Sem custos registados"
            description="Mao de obra e outros custos da instalacao aparecem aqui."
          />
        )}
        {technicalHistory && technicalHistory.installCosts.length > 0 && (
          <ul className="technical-list">
            {technicalHistory.installCosts.map((cost) => (
              <li key={cost.id} className="technical-item active">
                <div className="technical-item-head">
                  <strong>{INSTALL_COST_LABELS[cost.kind]}</strong>
                  <Badge tone="neutral">{formatCve(cost.amountCve)}</Badge>
                </div>
                <dl className="technical-item-meta">
                  <div><dt>Registado</dt><dd>{formatPtDateTime(cost.createdAt)}</dd></div>
                </dl>
                {cost.description && <p className="technical-item-notes">{cost.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="technical-section">
        <header className="technical-section-head">
          <div>
            <p className="eyebrow"><History size={12} /> Eventos tecnicos</p>
            <h3>{technicalHistory ? `${technicalHistory.events.length} evento(s)` : 'A carregar...'}</h3>
          </div>
          {canRecordTechnical && (
            <Button variant="secondary" size="sm" className="technical-add" leadingIcon={<Wrench size={14} aria-hidden />} onClick={onAddEvent}>
              Registar
            </Button>
          )}
        </header>
        {technicalHistory && technicalHistory.events.length === 0 && (
          <EmptyState
            size="sm"
            icon={History}
            title="Sem eventos registados"
            description="Quando criares ordens de serviço ou trocas de equipamento aparecem aqui."
          />
        )}
        {technicalHistory && technicalHistory.events.length > 0 && (
          <ul className="technical-timeline">
            {technicalHistory.events.map((event: ServiceEvent) => (
              <li key={event.id} className="technical-event">
                <div className="technical-event-head">
                  <Badge tone={eventTypeTone[event.eventType]}>{eventTypeLabel[event.eventType]}</Badge>
                  <small>{formatPtDateTime(event.createdAt)}</small>
                </div>
                {event.notes && <p className="technical-event-notes">{event.notes}</p>}
                {event.technicianName && (
                  <small className="technical-event-tech">Tecnico: {event.technicianName}</small>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>
    </Dialog>
  );
}
