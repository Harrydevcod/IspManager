import { ArrowRightLeft, Cable, Coins, History, PackageCheck, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, Message } from '../../components';
import { formatCve, formatPtDate, formatPtDateTime } from '../../lib/format';
import { statusLabel, statusTone } from '../../lib/status';
import type { DeviceAssignment, ManualServiceEventType, ServiceEvent, ServiceEventType, ServiceRow, TechnicalHistory } from '../../types';

/** Os tipos que o operador escolhe no formulário de evento. */
export const MANUAL_EVENT_TYPES: ManualServiceEventType[] = [
  'instalacao',
  'manutencao',
  'troca_equipamento',
  'visita',
  'alteracao_servico'
];

export const eventTypeLabel: Record<ServiceEventType, string> = {
  instalacao: 'Instalacao',
  manutencao: 'Manutencao',
  troca_equipamento: 'Troca de equipamento',
  visita: 'Visita tecnica',
  alteracao_servico: 'Alteracao de servico',
  // Escritos pelo backend: estado do serviço, o que a rede aplicou e a
  // transferência de titular.
  suspensao: 'Suspensao',
  reativacao: 'Reativacao',
  cancelamento: 'Cancelamento',
  corte_rede: 'Corte na rede',
  reposicao_rede: 'Reposicao na rede',
  transferencia: 'Transferencia de titular'
};

const eventTypeTone: Record<ServiceEventType, 'success' | 'info' | 'neutral' | 'accent' | 'warn' | 'danger'> = {
  instalacao: 'success',
  manutencao: 'info',
  troca_equipamento: 'info',
  visita: 'neutral',
  alteracao_servico: 'accent',
  suspensao: 'warn',
  reativacao: 'success',
  cancelamento: 'danger',
  corte_rede: 'warn',
  reposicao_rede: 'success',
  transferencia: 'accent'
};

export const RETURN_CONDITION_LABELS: Record<'bom' | 'avariado' | 'nao_devolvido', string> = {
  bom: 'Bom estado',
  avariado: 'Avariado',
  nao_devolvido: 'Não devolvido'
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
  onEditDevice: (assignment: DeviceAssignment) => void;
  onUnshareDevice: (assignment: DeviceAssignment) => void;
  onReplaceDevice: (assignment: DeviceAssignment) => void;
  /** Devolver uma unidade — abre o painel de devolução focado nela. */
  onReturnDevice: (assignment: DeviceAssignment) => void;
  /** Painel de devolução do serviço inteiro (equipamento + material). */
  onOpenReturns: () => void;
  /** O cliente compra o equipamento que tinha alugado — pára a renda. */
  onPurchaseDevice: (assignment: DeviceAssignment) => void;
  onAddEvent: () => void;
  /** Mudar o titular: a casa mudou de inquilino, ou o material vai para outro cliente. */
  onTransfer: () => void;
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
  onEditDevice,
  onUnshareDevice,
  onReplaceDevice,
  onReturnDevice,
  onOpenReturns,
  onPurchaseDevice,
  onAddEvent,
  onTransfer
}: ServiceDetailDialogProps) {
  // Fonte fresca após uma edição; enquanto o histórico carrega usa o valor da lista.
  const activeIps = technicalHistory
    ? technicalHistory.assignments.filter((a) => !a.endDate && a.ipAddress).map((a) => a.ipAddress).join(', ')
    : service.deviceIps;

  // Aluguer do equipamento instalado que é do ISP. É a mesma conta que o
  // servidor faz para a fatura; aqui serve para o número no ecrã bater certo
  // com o número no papel, que é a pergunta que o cliente faz ao telefone.
  const rentals = (technicalHistory?.assignments ?? [])
    .filter((a) => !a.endDate && a.isOwner && a.ownership === 'isp' && a.rentalFeeCve > 0);
  const rentalTotalCve = rentals.reduce((sum, a) => sum + a.rentalFeeCve, 0);

  // O que ainda está em casa do cliente: equipamento do ISP por fechar e material
  // por recuperar. Num serviço cancelado isto é uma dívida física, e diz-se.
  const pendingDevices = (technicalHistory?.assignments ?? [])
    .filter((a) => !a.endDate && a.isOwner && a.ownership === 'isp').length;
  const pendingMaterials = (technicalHistory?.materialReturns ?? [])
    .filter((m) => m.consumed - m.recovered > 0).length;
  const hasPendingReturns = pendingDevices + pendingMaterials > 0;

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
              <Button variant="secondary" size="sm" leadingIcon={<ArrowRightLeft size={16} aria-hidden />} onClick={onTransfer}>
                Transferir titular
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
        <div><dt>IP</dt><dd className="detail-ip">{activeIps || '-'}</dd></div>
        <div>
          <dt>Mensalidade</dt>
          <dd>
            {formatCve(monthlyTotalCve + rentalTotalCve)}
            {(rentalTotalCve > 0 || service.audiovisualMode === 'monthly') && (
              <small className="muted">
                {' '}({formatCve(monthlyTotalCve)}
                {service.audiovisualMode === 'monthly' ? ' NET+TVM' : ' plano'}
                {rentalTotalCve > 0 ? ` + ${formatCve(rentalTotalCve)} aluguer` : ''})
              </small>
            )}
          </dd>
        </div>
        {rentalTotalCve > 0 && (
          <div>
            <dt>Aluguer de equipamento</dt>
            <dd>{formatCve(rentalTotalCve)} / mês · {rentals.length} equipamento(s)</dd>
          </div>
        )}
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
        <div>
          <dt>Estado</dt>
          <dd>
            <Badge tone={statusTone(service.status)}>{statusLabel(service.status)}</Badge>
            {service.status === 'cancelled' && hasPendingReturns && (
              <> <Badge tone="warn">Equipamento por devolver</Badge></>
            )}
          </dd>
        </div>
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
            <div className="technical-section-actions">
              {hasPendingReturns && (
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<PackageCheck size={14} aria-hidden />}
                  onClick={onOpenReturns}
                >
                  Devolução
                </Button>
              )}
              <Button variant="secondary" size="sm" className="technical-add" leadingIcon={<Plus size={14} aria-hidden />} onClick={onAddDevice}>
                Adicionar
              </Button>
            </div>
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
                    {!assignment.isOwner && <Badge tone="info">Partilhada</Badge>}
                    {Boolean(assignment.isOwner) && (
                      assignment.ownership === 'cliente'
                        ? <Badge tone="accent">Do cliente</Badge>
                        : assignment.rentalFeeCve > 0
                          ? <Badge tone="neutral">{`Alugado · ${formatCve(assignment.rentalFeeCve)}/mês`}</Badge>
                          : null
                    )}
                    {Boolean(assignment.isOwner) && assignment.shareCount > 0 && (
                      <Badge tone="info">Serve {assignment.shareCount + 1} serviços</Badge>
                    )}
                    <Badge tone={active ? 'success' : 'neutral'}>{active ? 'Ativo' : 'Removido'}</Badge>
                  </div>
                  <dl className="technical-item-meta">
                    {assignment.serialNumber && <div><dt>Serial</dt><dd>{assignment.serialNumber}</dd></div>}
                    {assignment.macAddress && <div><dt>MAC</dt><dd>{assignment.macAddress}</dd></div>}
                    {assignment.ipAddress && <div><dt>IP</dt><dd>{assignment.ipAddress}</dd></div>}
                    {assignment.assetTag && <div><dt>Tag</dt><dd>{assignment.assetTag}</dd></div>}
                    <div><dt>Inicio</dt><dd>{formatPtDate(assignment.startDate)}</dd></div>
                    {assignment.endDate && <div><dt>Fim</dt><dd>{formatPtDate(assignment.endDate)}</dd></div>}
                    {assignment.returnCondition && (
                      <div><dt>Devolvido</dt><dd>{RETURN_CONDITION_LABELS[assignment.returnCondition]}</dd></div>
                    )}
                    {assignment.ownedSince && (
                      <div><dt>Do cliente desde</dt><dd>{formatPtDate(assignment.ownedSince)}</dd></div>
                    )}
                    {assignment.sharedWithNames && (
                      <div><dt>Também serve</dt><dd>{assignment.sharedWithNames}</dd></div>
                    )}
                  </dl>
                  {assignment.notes && <p className="technical-item-notes">{assignment.notes}</p>}
                  {active && canRecordTechnical && (
                    <div className="technical-item-actions">
                      {assignment.isOwner ? (
                        <>
                          <Button variant="secondary" size="sm" disabled={submitting} onClick={() => onEditDevice(assignment)}>
                            Editar
                          </Button>
                          <Button variant="secondary" size="sm" disabled={submitting} onClick={() => onReplaceDevice(assignment)}>
                            Substituir
                          </Button>
                          {canManage && assignment.ownership === 'isp' && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={submitting}
                              leadingIcon={<Coins size={14} aria-hidden />}
                              onClick={() => onPurchaseDevice(assignment)}
                            >
                              Cliente comprou
                            </Button>
                          )}
                          <Button variant="danger" size="sm" disabled={submitting} onClick={() => onReturnDevice(assignment)}>
                            Devolver
                          </Button>
                        </>
                      ) : (
                        // A unidade física pertence a outro serviço: daqui só se corta a ligação.
                        <Button variant="danger" size="sm" disabled={submitting} onClick={() => onUnshareDevice(assignment)}>
                          Desassociar
                        </Button>
                      )}
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
