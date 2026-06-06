import { Cable, History, Pencil, Plus, Wrench } from 'lucide-react';
import type { FormEvent } from 'react';
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

type DeviceFormState = {
  catalogId: string;
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

function emptyDeviceForm(): DeviceFormState {
  return { catalogId: '', serialNumber: '', assetTag: '', ipAddress: '', macAddress: '', notes: '' };
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
  const [attachDevice, setAttachDevice] = useState(false);
  const [newServiceDevice, setNewServiceDevice] = useState<DeviceFormState>(emptyDeviceForm());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ServiceRow['status']>('all');
  const [form, setForm] = useState<ServiceFormState>(emptyServiceForm());
  const [technicalHistory, setTechnicalHistory] = useState<TechnicalHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [catalogList, setCatalogList] = useState<StockCatalogRow[]>([]);
  const [showDeviceDialog, setShowDeviceDialog] = useState(false);
  const [deviceForm, setDeviceForm] = useState<DeviceFormState>(emptyDeviceForm());
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
    setAttachDevice(false);
    setNewServiceDevice(emptyDeviceForm());
    setShowForm(true);
  }

  function toggleAttachDevice(next: boolean) {
    setAttachDevice(next);
    if (next) {
      void ensureCatalogLoaded();
    } else {
      setNewServiceDevice(emptyDeviceForm());
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
    setAttachDevice(false);
    setNewServiceDevice(emptyDeviceForm());
  }

  async function loadTechnicalHistory(serviceId: number) {
    setHistoryLoading(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${serviceId}/technical-history`);
      if (!response.ok) {
        setTechnicalHistory({ serviceId, assignments: [], events: [] });
        return;
      }
      const data = await response.json() as TechnicalHistory;
      setTechnicalHistory(data);
    } catch {
      setTechnicalHistory({ serviceId, assignments: [], events: [] });
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
    setDeviceForm(emptyDeviceForm());
    void ensureCatalogLoaded();
    setShowDeviceDialog(true);
  }

  function closeDeviceDialog() {
    if (submitting) return;
    setShowDeviceDialog(false);
    setDeviceForm(emptyDeviceForm());
  }

  async function submitDeviceAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedService) return;
    if (!deviceForm.catalogId) {
      toast('Seleciona o modelo do equipamento.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${selectedService.id}/device-assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalogId: Number(deviceForm.catalogId),
          serialNumber: deviceForm.serialNumber || null,
          assetTag: deviceForm.assetTag || null,
          ipAddress: deviceForm.ipAddress || null,
          macAddress: deviceForm.macAddress || null,
          notes: deviceForm.notes || null
        })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel atribuir o equipamento.', 'error');
        return;
      }
      toast('Equipamento atribuido ao servico.', 'success');
      setShowDeviceDialog(false);
      setDeviceForm(emptyDeviceForm());
      await loadTechnicalHistory(selectedService.id);
    } catch {
      toast('Falha de rede ao atribuir equipamento.', 'error');
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

    const installingDevice = !editingService && attachDevice;
    if (installingDevice && !newServiceDevice.catalogId) {
      toast('Seleciona o modelo do equipamento a instalar.', 'error');
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
        device: installingDevice
          ? {
              catalogId: Number(newServiceDevice.catalogId),
              serialNumber: newServiceDevice.serialNumber || null,
              assetTag: newServiceDevice.assetTag || null,
              ipAddress: newServiceDevice.ipAddress || null,
              macAddress: newServiceDevice.macAddress || null,
              notes: newServiceDevice.notes || null
            }
          : undefined
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
        : installingDevice
          ? 'Servico criado e equipamento instalado.'
          : 'Servico criado.',
      'success'
    );
    closeForm();
    await loadServices();
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
            <div className="service-equipment-section">
              <Toggle
                title="Instalar equipamento agora"
                description="Atribui hardware ao serviço e abate o stock no momento da criação."
                checked={attachDevice}
                onChange={(event) => toggleAttachDevice(event.target.checked)}
              />
              {attachDevice && (
                <>
                  <Select
                    wide
                    label="Modelo do equipamento"
                    required
                    value={newServiceDevice.catalogId}
                    onChange={(event) => setNewServiceDevice((c) => ({ ...c, catalogId: event.target.value }))}
                  >
                    <option value="">Selecionar modelo</option>
                    {catalogList.map((item) => (
                      <option key={item.id} value={item.id} disabled={item.stockTotal < 1}>
                        {item.brand ? `${item.brand} ${item.model}` : item.model} - {item.type} - {item.stockTotal} un.
                      </option>
                    ))}
                  </Select>
                  <Field label="Serial" value={newServiceDevice.serialNumber} onChange={(event) => setNewServiceDevice((c) => ({ ...c, serialNumber: event.target.value }))} />
                  <Field label="Asset tag" value={newServiceDevice.assetTag} onChange={(event) => setNewServiceDevice((c) => ({ ...c, assetTag: event.target.value }))} />
                  <Field label="MAC" value={newServiceDevice.macAddress} onChange={(event) => setNewServiceDevice((c) => ({ ...c, macAddress: event.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" />
                  <Field label="IP" value={newServiceDevice.ipAddress} onChange={(event) => setNewServiceDevice((c) => ({ ...c, ipAddress: event.target.value }))} placeholder="192.168.X.Y" />
                  <Field wide label="Notas do equipamento" value={newServiceDevice.notes} onChange={(event) => setNewServiceDevice((c) => ({ ...c, notes: event.target.value }))} />
                </>
              )}
            </div>
          )}
        </form>
      </Dialog>

      <Dialog
        open={showDeviceDialog}
        onClose={closeDeviceDialog}
        eyebrow="Equipamento"
        title={selectedService ? `Atribuir a ${selectedService.clientName}` : 'Atribuir equipamento'}
        size="md"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeDeviceDialog} disabled={submitting}>Cancelar</Button>
            <Button type="submit" form="device-form" loading={submitting}>
              {submitting ? 'A gravar...' : 'Atribuir'}
            </Button>
          </>
        }
      >
        <form id="device-form" className="client-form" onSubmit={submitDeviceAssignment}>
          <Select wide label="Modelo do equipamento" required value={deviceForm.catalogId} onChange={(event) => setDeviceForm((c) => ({ ...c, catalogId: event.target.value }))}>
            <option value="">Selecionar modelo</option>
            {catalogList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.brand ? `${item.brand} ${item.model}` : item.model} - {item.type} - {item.stockTotal} un.
              </option>
            ))}
          </Select>
          <Field label="Serial" value={deviceForm.serialNumber} onChange={(event) => setDeviceForm((c) => ({ ...c, serialNumber: event.target.value }))} />
          <Field label="Asset tag" value={deviceForm.assetTag} onChange={(event) => setDeviceForm((c) => ({ ...c, assetTag: event.target.value }))} />
          <Field label="MAC" value={deviceForm.macAddress} onChange={(event) => setDeviceForm((c) => ({ ...c, macAddress: event.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" />
          <Field label="IP" value={deviceForm.ipAddress} onChange={(event) => setDeviceForm((c) => ({ ...c, ipAddress: event.target.value }))} placeholder="192.168.X.Y" />
          <Field wide label="Notas" value={deviceForm.notes} onChange={(event) => setDeviceForm((c) => ({ ...c, notes: event.target.value }))} />
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
