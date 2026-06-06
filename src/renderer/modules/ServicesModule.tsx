import { Cable, Coins, History, Pencil, Plus, Wrench } from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useEffect, useState } from 'react';
import { Badge, Button, Combobox, DetailPanel, Dialog, EmptyState, Field, FilterBar, Message, Select, Textarea, Toggle, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { formatCve, formatPtDate, formatPtDateTime } from '../lib/format';
import { statusLabel, statusTone } from '../lib/status';
import type { Client, DeviceAssignment, PlanRow, ServiceEvent, ServiceEventType, ServiceRow, StockCatalogRow, StockSummary, TechnicalHistory } from '../types';

const eventTypeLabel: Record<ServiceEventType, string> = {
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

type ItemDraft = {
  category: 'equipamento' | 'material';
  catalogId: string;
  quantity: string;
  serialNumber: string;
  assetTag: string;
  ipAddress: string;
  macAddress: string;
  notes: string;
};

type EventFormState = {
  eventType: ServiceEventType;
  notes: string;
};

function emptyItemDraft(category: 'equipamento' | 'material' = 'equipamento'): ItemDraft {
  return { category, catalogId: '', quantity: '1', serialNumber: '', assetTag: '', ipAddress: '', macAddress: '', notes: '' };
}

function emptyEventForm(): EventFormState {
  return { eventType: 'visita', notes: '' };
}

type ServiceFormState = {
  clientId: string;
  planId: string;
  monthlyValueCve: string;
  dueDay: string;
  activationDate: string;
  status: 'active' | 'suspended' | 'cancelled';
  technicalNotes: string;
};

function emptyServiceForm(): ServiceFormState {
  return {
    clientId: '',
    planId: '',
    monthlyValueCve: '',
    dueDay: '1',
    activationDate: new Date().toISOString().slice(0, 10),
    status: 'active',
    technicalNotes: ''
  };
}

export function ServicesModule({
  focusClientId,
  onFocusHandled
}: {
  focusClientId?: number | null;
  onFocusHandled?: () => void;
} = {}) {
  const { toast } = useToast();
  const auth = useAuth();
  const canManageServices = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const canRecordTechnical = auth.isAuthBypassed || auth.hasRole('admin', 'operator', 'technician');
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [selectedService, setSelectedService] = useState<ServiceRow | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingService, setEditingService] = useState<ServiceRow | null>(null);
  const [attachItems, setAttachItems] = useState(false);
  const [itemDrafts, setItemDrafts] = useState<ItemDraft[]>([]);
  const [laborCve, setLaborCve] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ServiceRow['status']>('all');
  const [form, setForm] = useState<ServiceFormState>(emptyServiceForm());
  const [technicalHistory, setTechnicalHistory] = useState<TechnicalHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [catalogList, setCatalogList] = useState<StockCatalogRow[]>([]);
  const [showDeviceDialog, setShowDeviceDialog] = useState(false);
  const [addItemDrafts, setAddItemDrafts] = useState<ItemDraft[]>([]);
  const [addLaborCve, setAddLaborCve] = useState('');
  const [showEventDialog, setShowEventDialog] = useState(false);
  const [eventForm, setEventForm] = useState<EventFormState>(emptyEventForm());
  const [submitting, setSubmitting] = useState(false);

  function loadServices() {
    return authFetch('http://127.0.0.1:3001/api/services')
      .then((response) => response.json() as Promise<ServiceRow[]>)
      .then(setServices)
      .catch(() => setServices([]));
  }

  useEffect(() => {
    void loadServices();
    authFetch('http://127.0.0.1:3001/api/clients')
      .then((response) => response.json() as Promise<Client[]>)
      .then(setClients)
      .catch(() => setClients([]));
    authFetch('http://127.0.0.1:3001/api/plans')
      .then((response) => response.json() as Promise<PlanRow[]>)
      .then(setPlans)
      .catch(() => setPlans([]));
  }, []);

  function updateForm(field: keyof ServiceFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectPlan(planId: string) {
    const plan = plans.find((item) => String(item.id) === planId);
    setForm((current) => ({
      ...current,
      planId,
      monthlyValueCve: plan ? String(plan.monthlyPriceCve) : current.monthlyValueCve
    }));
  }

  function openCreate() {
    setSelectedService(null);
    setEditingService(null);
    setForm(emptyServiceForm());
    setAttachItems(false);
    setItemDrafts([]);
    setLaborCve('');
    setShowForm(true);
  }

  function toggleAttachItems(next: boolean) {
    setAttachItems(next);
    if (next) {
      void ensureCatalogLoaded();
    } else {
      setItemDrafts([]);
      setLaborCve('');
    }
  }

  function editService(service: ServiceRow) {
    setEditingService(service);
    setSelectedService(null);
    setForm({
      clientId: String(service.clientId),
      planId: service.planId ? String(service.planId) : '',
      monthlyValueCve: String(service.monthlyValueCve),
      dueDay: String(service.dueDay),
      activationDate: service.activationDate || new Date().toISOString().slice(0, 10),
      status: service.status,
      technicalNotes: service.technicalNotes || ''
    });
    setShowForm(true);
  }

  function closeForm() {
    setEditingService(null);
    setShowForm(false);
    setForm(emptyServiceForm());
    setAttachItems(false);
    setItemDrafts([]);
    setLaborCve('');
  }

  async function loadTechnicalHistory(serviceId: number) {
    setHistoryLoading(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${serviceId}/technical-history`);
      if (!response.ok) {
        setTechnicalHistory({ serviceId, assignments: [], materials: [], installCosts: [], events: [] });
        return;
      }
      const data = await response.json() as TechnicalHistory;
      setTechnicalHistory(data);
    } catch {
      setTechnicalHistory({ serviceId, assignments: [], materials: [], installCosts: [], events: [] });
    } finally {
      setHistoryLoading(false);
    }
  }

  async function ensureCatalogLoaded() {
    if (catalogList.length > 0) return;
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/stock/summary');
      if (!response.ok) return;
      const data = await response.json() as StockSummary;
      setCatalogList(data.rows.filter((r) => r.active));
    } catch {
      // silent
    }
  }

  useEffect(() => {
    if (!selectedService) {
      setTechnicalHistory(null);
      return;
    }
    void loadTechnicalHistory(selectedService.id);
  }, [selectedService]);

  useEffect(() => {
    if (!focusClientId || services.length === 0) return;
    const clientServices = services.filter((service) => service.clientId === focusClientId);
    if (clientServices.length > 0) {
      setSearch(clientServices[0].clientName);
      setStatusFilter('all');
      if (clientServices.length === 1) {
        setSelectedService(clientServices[0]);
      }
    }
    onFocusHandled?.();
  }, [focusClientId, services, onFocusHandled]);

  function openDeviceDialog() {
    setAddItemDrafts([]);
    setAddLaborCve('');
    void ensureCatalogLoaded();
    setShowDeviceDialog(true);
  }

  function closeDeviceDialog() {
    if (submitting) return;
    setShowDeviceDialog(false);
    setAddItemDrafts([]);
    setAddLaborCve('');
  }

  function updateItemDraft(setter: Dispatch<SetStateAction<ItemDraft[]>>, index: number, patch: Partial<ItemDraft>) {
    setter((current) => current.map((draft, i) => i === index ? { ...draft, ...patch } : draft));
  }

  function removeItemDraft(setter: Dispatch<SetStateAction<ItemDraft[]>>, index: number) {
    setter((current) => current.filter((_, i) => i !== index));
  }

  function buildItemsPayload(drafts: ItemDraft[], catalog: StockCatalogRow[]) {
    return drafts
      .filter((draft) => draft.catalogId)
      .map((draft) => {
        const item = catalog.find((row) => String(row.id) === draft.catalogId);
        const serialized = item?.isSerialized !== 0;
        return serialized
          ? {
              catalogId: Number(draft.catalogId),
              serialNumber: draft.serialNumber || null,
              assetTag: draft.assetTag || null,
              ipAddress: draft.ipAddress || null,
              macAddress: draft.macAddress || null,
              notes: draft.notes || null
            }
          : {
              catalogId: Number(draft.catalogId),
              quantity: Number(draft.quantity || 1),
              notes: draft.notes || null
            };
      });
  }

  function buildInstallCostsPayload(labor: string) {
    const amount = Number(labor || 0);
    return amount > 0 ? [{ kind: 'mao_de_obra' as const, amountCve: amount }] : [];
  }

  function hasInvalidMaterialQuantity(drafts: ItemDraft[]) {
    return drafts.some((draft) => {
      if (!draft.catalogId) return false;
      const item = catalogList.find((row) => String(row.id) === draft.catalogId);
      return item?.isSerialized === 0 && Number(draft.quantity || 0) < 1;
    });
  }

  async function submitItems(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedService) return;
    const items = buildItemsPayload(addItemDrafts, catalogList);
    const installCosts = buildInstallCostsPayload(addLaborCve);
    if (items.length === 0 && installCosts.length === 0) {
      toast('Adiciona pelo menos um item ou mao de obra.', 'error');
      return;
    }
    if (hasInvalidMaterialQuantity(addItemDrafts)) {
      toast('Quantidade de material invalida.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${selectedService.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: items.length > 0 ? items : undefined,
          installCosts: installCosts.length > 0 ? installCosts : undefined
        })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel adicionar os itens.', 'error');
        return;
      }
      toast('Itens adicionados ao servico.', 'success');
      setShowDeviceDialog(false);
      setAddItemDrafts([]);
      setAddLaborCve('');
      await loadTechnicalHistory(selectedService.id);
    } catch {
      toast('Falha de rede ao adicionar itens.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function openEventDialog() {
    setEventForm(emptyEventForm());
    setShowEventDialog(true);
  }

  function closeEventDialog() {
    if (submitting) return;
    setShowEventDialog(false);
    setEventForm(emptyEventForm());
  }

  async function submitEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedService) return;
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${selectedService.id}/technical-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: eventForm.eventType,
          notes: eventForm.notes || null
        })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel registar o evento.', 'error');
        return;
      }
      toast('Evento tecnico registado.', 'success');
      setShowEventDialog(false);
      setEventForm(emptyEventForm());
      await loadTechnicalHistory(selectedService.id);
    } catch {
      toast('Falha de rede ao registar evento.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function saveService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const items = !editingService && attachItems ? buildItemsPayload(itemDrafts, catalogList) : [];
    const installCosts = !editingService && attachItems ? buildInstallCostsPayload(laborCve) : [];
    if (!editingService && attachItems && items.length === 0 && installCosts.length === 0) {
      toast('Adiciona pelo menos um item ou mao de obra.', 'error');
      return;
    }
    if (!editingService && attachItems && hasInvalidMaterialQuantity(itemDrafts)) {
      toast('Quantidade de material invalida.', 'error');
      return;
    }

    const url = editingService ? `http://127.0.0.1:3001/api/services/${editingService.id}` : 'http://127.0.0.1:3001/api/services';
    const response = await authFetch(url, {
      method: editingService ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: Number(form.clientId),
        planId: form.planId ? Number(form.planId) : null,
        monthlyValueCve: Number(form.monthlyValueCve),
        dueDay: Number(form.dueDay),
        activationDate: form.activationDate,
        status: form.status,
        technicalNotes: form.technicalNotes,
        items: items.length > 0 ? items : undefined,
        installCosts: installCosts.length > 0 ? installCosts : undefined
      })
    });

    if (!response.ok) {
      const result = await response.json() as { error?: string };
      toast(result.error || (editingService ? 'Nao foi possivel atualizar o servico.' : 'Nao foi possivel criar o servico.'), 'error');
      return;
    }

    toast(
      editingService
        ? 'Servico atualizado.'
        : items.length > 0 || installCosts.length > 0
          ? 'Servico criado e instalacao registada.'
          : 'Servico criado.',
      'success'
    );
    closeForm();
    await loadServices();
  }

  function renderItemGroup(
    drafts: ItemDraft[],
    setter: Dispatch<SetStateAction<ItemDraft[]>>,
    category: 'equipamento' | 'material'
  ) {
    const isMaterial = category === 'material';
    const catalog = catalogList.filter((item) => item.category === category);
    const rows = drafts
      .map((draft, index) => ({ draft, index }))
      .filter((row) => row.draft.category === category);

    return (
      <div className="service-items-group">
        <p className="service-items-group-title">{isMaterial ? 'Materiais' : 'Equipamentos'}</p>
        {rows.length === 0 && (
          <Message>{isMaterial ? 'Sem materiais adicionados.' : 'Sem equipamentos adicionados.'}</Message>
        )}
        {rows.map(({ draft, index }) => {
          const selectedItem = catalog.find((item) => String(item.id) === draft.catalogId);
          return (
            <div className="service-item-draft" key={index}>
              <Select
                wide
                label={isMaterial ? 'Material' : 'Equipamento'}
                required
                value={draft.catalogId}
                onChange={(event) => updateItemDraft(setter, index, { catalogId: event.target.value })}
              >
                <option value="">{isMaterial ? 'Selecionar material' : 'Selecionar equipamento'}</option>
                {catalog.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.stockTotal < 1}>
                    {item.brand ? `${item.brand} ${item.model}` : item.model} - {item.type} - {item.stockTotal} {item.unitOfMeasure}
                  </option>
                ))}
              </Select>
              {isMaterial ? (
                <Field
                  label={`Quantidade${selectedItem ? ` (${selectedItem.unitOfMeasure})` : ''}`}
                  required
                  type="number"
                  min={1}
                  max={selectedItem?.stockTotal}
                  value={draft.quantity}
                  onChange={(event) => updateItemDraft(setter, index, { quantity: event.target.value })}
                />
              ) : (
                <>
                  <Field label="Serial" value={draft.serialNumber} onChange={(event) => updateItemDraft(setter, index, { serialNumber: event.target.value })} />
                  <Field label="Asset tag" value={draft.assetTag} onChange={(event) => updateItemDraft(setter, index, { assetTag: event.target.value })} />
                  <Field label="MAC" value={draft.macAddress} onChange={(event) => updateItemDraft(setter, index, { macAddress: event.target.value })} placeholder="AA:BB:CC:DD:EE:FF" />
                  <Field label="IP" value={draft.ipAddress} onChange={(event) => updateItemDraft(setter, index, { ipAddress: event.target.value })} placeholder="192.168.X.Y" />
                </>
              )}
              <Field wide label="Notas" value={draft.notes} onChange={(event) => updateItemDraft(setter, index, { notes: event.target.value })} />
              <Button type="button" variant="secondary" size="sm" onClick={() => removeItemDraft(setter, index)}>
                Remover linha
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="secondary" size="sm" onClick={() => setter((current) => [...current, emptyItemDraft(category)])}>
          {isMaterial ? 'Adicionar material' : 'Adicionar equipamento'}
        </Button>
      </div>
    );
  }

  function renderItemDrafts(
    drafts: ItemDraft[],
    setter: Dispatch<SetStateAction<ItemDraft[]>>
  ) {
    return (
      <div className="service-items-builder">
        {renderItemGroup(drafts, setter, 'equipamento')}
        {renderItemGroup(drafts, setter, 'material')}
      </div>
    );
  }

  const visibleServices = services.filter((service) => {
    const normalizedSearch = search.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || service.clientName.toLowerCase().includes(normalizedSearch)
      || (service.planName || '').toLowerCase().includes(normalizedSearch);
    const matchesStatus = statusFilter === 'all' || service.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Servicos</h2>
        </div>
        {canManageServices && (
          <Button onClick={openCreate}>
            Novo servico
          </Button>
        )}
      </div>

      <FilterBar>
        <Field type="search" label="Buscar" aria-label="Pesquisar servicos" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cliente ou plano" />
        <Select label="Estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | ServiceRow['status'])}>
          <option value="all">Todos</option>
          <option value="active">Ativos</option>
          <option value="suspended">Suspensos</option>
          <option value="cancelled">Cancelados</option>
        </Select>
        <Button variant="secondary" onClick={() => {
          setSearch('');
          setStatusFilter('all');
        }}>
          Limpar filtros
        </Button>
        <small>{visibleServices.length} servicos</small>
      </FilterBar>

      {selectedService && (
        <DetailPanel
          eyebrow="Servico"
          title={selectedService.clientName}
          actionsClassName="client-preview-actions"
          onClose={() => setSelectedService(null)}
          actions={
            canManageServices
              ? (
                <Button variant="secondary" size="sm" leadingIcon={<Pencil size={16} aria-hidden />} onClick={() => editService(selectedService)}>
                  Editar
                </Button>
              )
              : undefined
          }
        >
          <dl>
            <div><dt>Plano</dt><dd>{selectedService.planName || '-'}</dd></div>
            <div><dt>Mensalidade</dt><dd>{formatCve(selectedService.monthlyValueCve)}</dd></div>
            <div><dt>Vencimento</dt><dd>Dia {selectedService.dueDay}</dd></div>
            <div><dt>Ativado em</dt><dd>{formatPtDate(selectedService.activationDate)}</dd></div>
            <div><dt>Estado</dt><dd><Badge tone={statusTone(selectedService.status)}>{statusLabel(selectedService.status)}</Badge></dd></div>
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
                <Button variant="secondary" size="sm" className="technical-add" leadingIcon={<Plus size={14} aria-hidden />} onClick={openDeviceDialog}>
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
                <Button variant="secondary" size="sm" className="technical-add" leadingIcon={<Wrench size={14} aria-hidden />} onClick={openEventDialog}>
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
        </DetailPanel>
      )}

      <div className="module-table">
        {visibleServices.map((service) => (
          <div
            className="module-row service-row interactive"
            key={service.id}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedService(service)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelectedService(service);
              }
            }}
          >
            <span>
              <strong>{service.clientName}</strong>
              <small>{service.planName || 'Sem plano'} - dia {service.dueDay}</small>
            </span>
            <small>{formatCve(service.monthlyValueCve)}</small>
            <Badge tone={statusTone(service.status)}>{statusLabel(service.status)}</Badge>
            {canManageServices && (
              <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                <Button
                  variant="icon"
                  size="sm"
                  className="row-action"
                  title="Editar servico"
                  aria-label="Editar servico"
                  onClick={(event) => {
                    event.stopPropagation();
                    editService(service);
                  }}
                >
                  <Pencil size={14} aria-hidden />
                </Button>
              </div>
            )}
          </div>
        ))}
        {visibleServices.length === 0 && (
          <EmptyState
            icon={Wrench}
            title="Nenhum serviço encontrado"
            description="Ajusta os filtros ou ativa um novo serviço para um cliente."
          />
        )}
      </div>

      <Dialog
        open={showForm}
        onClose={closeForm}
        eyebrow={editingService ? 'Editar servico' : 'Novo servico'}
        title={editingService ? editingService.clientName : 'Servico'}
        size="md"
        actions={
          <>
            <Button variant="secondary" onClick={closeForm}>Cancelar</Button>
            <Button type="submit" form="service-form">
              {editingService ? 'Atualizar servico' : 'Gravar servico'}
            </Button>
          </>
        }
      >
        <form id="service-form" className="client-form" onSubmit={saveService}>
          <label className="field">
            <span className="field-label">Cliente</span>
            <Combobox
              ariaLabel="Cliente"
              options={clients}
              value={form.clientId ? Number(form.clientId) : null}
              onChange={(next) => updateForm('clientId', next == null ? '' : String(next))}
              rowKey={(client) => client.id}
              rowCode={(client) => client.clientCode}
              rowLabel={(client) => client.fullName}
              rowHint={(client) => client.phone || undefined}
              placeholder="Selecionar cliente..."
            />
          </label>
          <Select label="Plano" value={form.planId} onChange={(event) => selectPlan(event.target.value)}>
            <option value="">Sem plano</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>{plan.name} - {plan.monthlyPriceCve.toLocaleString('pt-PT')} CVE</option>
            ))}
          </Select>
          <Field label="Mensalidade CVE" required type="number" min={0} value={form.monthlyValueCve} onChange={(event) => updateForm('monthlyValueCve', event.target.value)} />
          <Field label="Dia de vencimento" required type="number" min={1} max={31} value={form.dueDay} onChange={(event) => updateForm('dueDay', event.target.value)} />
          <Field label="Data de ativacao" type="date" value={form.activationDate} onChange={(event) => updateForm('activationDate', event.target.value)} />
          <Select label="Estado" value={form.status} onChange={(event) => updateForm('status', event.target.value)}>
            <option value="active">Ativo</option>
            <option value="suspended">Suspenso</option>
            <option value="cancelled">Cancelado</option>
          </Select>
          <Field wide label="Notas tecnicas" value={form.technicalNotes} onChange={(event) => updateForm('technicalNotes', event.target.value)} />

          {!editingService && canRecordTechnical && (
            <div className="service-items-builder">
              <Toggle
                title="Registar instalacao agora"
                description="Atribui equipamento/materiais, abate o stock e contabiliza a mão de obra no momento da criação."
                checked={attachItems}
                onChange={(event) => toggleAttachItems(event.target.checked)}
              />
              {attachItems && (
                <>
                  {renderItemDrafts(itemDrafts, setItemDrafts)}
                  <Field
                    wide
                    label="Mão de obra (CVE)"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="0"
                    value={laborCve}
                    onChange={(event) => setLaborCve(event.target.value)}
                  />
                </>
              )}
            </div>
          )}
        </form>
      </Dialog>

      <Dialog
        open={showDeviceDialog}
        onClose={closeDeviceDialog}
        eyebrow="Itens"
        title={selectedService ? `Adicionar a ${selectedService.clientName}` : 'Adicionar itens'}
        size="md"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeDeviceDialog} disabled={submitting}>Cancelar</Button>
            <Button type="submit" form="device-form" loading={submitting}>
              {submitting ? 'A gravar...' : 'Adicionar'}
            </Button>
          </>
        }
      >
        <form id="device-form" className="client-form" onSubmit={submitItems}>
          {renderItemDrafts(addItemDrafts, setAddItemDrafts)}
          <Field
            wide
            label="Mão de obra (CVE)"
            type="number"
            min={0}
            step="0.01"
            placeholder="0"
            value={addLaborCve}
            onChange={(event) => setAddLaborCve(event.target.value)}
          />
        </form>
      </Dialog>

      <Dialog
        open={showEventDialog}
        onClose={closeEventDialog}
        eyebrow="Evento tecnico"
        title={selectedService ? `Registar para ${selectedService.clientName}` : 'Registar evento'}
        size="md"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeEventDialog} disabled={submitting}>Cancelar</Button>
            <Button type="submit" form="event-form" loading={submitting}>
              {submitting ? 'A gravar...' : 'Registar'}
            </Button>
          </>
        }
      >
        <form id="event-form" className="client-form" onSubmit={submitEvent}>
          <Select wide label="Tipo de evento" required value={eventForm.eventType} onChange={(event) => setEventForm((c) => ({ ...c, eventType: event.target.value as ServiceEventType }))}>
            {(Object.keys(eventTypeLabel) as ServiceEventType[]).map((key) => (
              <option key={key} value={key}>{eventTypeLabel[key]}</option>
            ))}
          </Select>
          <Textarea
            label="Notas"
            rows={4}
            value={eventForm.notes}
            onChange={(event) => setEventForm((c) => ({ ...c, notes: event.target.value }))}
            placeholder="Detalhes da intervencao, observacoes, peca substituida..."
          />
        </form>
      </Dialog>
    </section>
  );
}
