import { Pencil, Wrench } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Combobox, Dialog, EmptyState, ErrorRetry, Field, FilterBar, Message, Select, SkeletonList, Textarea, Toggle, useConfirm, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { formatCve } from '../lib/format';
import { takesStaticIp } from '../../shared/equipment';
import { suggestIpPrefix } from '../lib/ip';
import { statusLabel, statusTone } from '../lib/status';
import type { AudiovisualConfig, Client, DeviceAssignment, PlanRow, ServiceEventType, ServiceRow, StockCatalogRow, StockSummary, TechnicalHistory } from '../types';
import { BulkIpDialog, type ActiveAssignment } from './services/BulkIpDialog';
import { IpField } from './services/IpField';
import { ServiceDetailDialog, eventTypeLabel } from './services/ServiceDetailDialog';
import { ServiceItemDraftsBuilder, emptyItemDraft, type ItemDraft } from './services/ServiceItemDraftsBuilder';

type EventFormState = {
  eventType: ServiceEventType;
  notes: string;
};

function emptyEventForm(): EventFormState {
  return { eventType: 'visita', notes: '' };
}

/**
 * Mensalidade efetiva = internet + audiovisual mensal. A anuidade audiovisual é
 * faturada à parte (fatura anual separada), por isso NÃO entra no valor mensal.
 */
function monthlyTotalCve(
  service: Pick<ServiceRow, 'monthlyValueCve' | 'audiovisualMode' | 'audiovisualMonthlyCve'>
): number {
  return service.monthlyValueCve + (service.audiovisualMode === 'monthly' ? service.audiovisualMonthlyCve : 0);
}

type ServiceFormState = {
  clientId: string;
  planId: string;
  monthlyValueCve: string;
  dueDay: string;
  activationDate: string;
  status: 'active' | 'suspended' | 'cancelled';
  technicalNotes: string;
  audiovisualMode: 'none' | 'monthly' | 'annual';
  audiovisualMonthlyCve: string;
  audiovisualAnnualCve: string;
};

function emptyServiceForm(): ServiceFormState {
  return {
    clientId: '',
    planId: '',
    monthlyValueCve: '',
    dueDay: '1',
    activationDate: new Date().toISOString().slice(0, 10),
    status: 'active',
    technicalNotes: '',
    audiovisualMode: 'none',
    audiovisualMonthlyCve: '',
    audiovisualAnnualCve: ''
  };
}

const DEFAULT_SERVICE_STATUS_FILTER: 'all' | ServiceRow['status'] = 'active';

export function ServicesModule({
  focusClientId,
  onFocusHandled
}: {
  focusClientId?: number | null;
  onFocusHandled?: () => void;
} = {}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const auth = useAuth();
  const canManageServices = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const canRecordTechnical = auth.isAuthBypassed || auth.hasRole('admin', 'operator', 'technician');
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<ServiceRow | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [avConfig, setAvConfig] = useState<AudiovisualConfig | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingService, setEditingService] = useState<ServiceRow | null>(null);
  const [attachItems, setAttachItems] = useState(false);
  const [itemDrafts, setItemDrafts] = useState<ItemDraft[]>([]);
  const [laborCve, setLaborCve] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ServiceRow['status']>(
    DEFAULT_SERVICE_STATUS_FILTER
  );
  const [form, setForm] = useState<ServiceFormState>(emptyServiceForm());
  const [technicalHistory, setTechnicalHistory] = useState<TechnicalHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [catalogList, setCatalogList] = useState<StockCatalogRow[]>([]);
  const [showDeviceDialog, setShowDeviceDialog] = useState(false);
  const [addItemDrafts, setAddItemDrafts] = useState<ItemDraft[]>([]);
  const [addLaborCve, setAddLaborCve] = useState('');
  const [showEventDialog, setShowEventDialog] = useState(false);
  const [eventForm, setEventForm] = useState<EventFormState>(emptyEventForm());
  const [replaceTarget, setReplaceTarget] = useState<DeviceAssignment | null>(null);
  const [replaceDraft, setReplaceDraft] = useState<ItemDraft>(emptyItemDraft('equipamento'));
  const [editTarget, setEditTarget] = useState<DeviceAssignment | null>(null);
  const [editDraft, setEditDraft] = useState<ItemDraft>(emptyItemDraft('equipamento'));
  const [submitting, setSubmitting] = useState(false);
  const [showBulkIp, setShowBulkIp] = useState(false);
  const [deviceMode, setDeviceMode] = useState<'install' | 'share'>('install');
  const [shareableDevices, setShareableDevices] = useState<ActiveAssignment[]>([]);
  const [shareChoice, setShareChoice] = useState('');
  // Sugestão de faixa vinda da própria rede instalada, não fixa no código.
  const ipPrefix = useMemo(() => suggestIpPrefix(services.map((service) => service.deviceIps)), [services]);

  function loadServices() {
    setLoading(true);
    return authFetch('http://127.0.0.1:3001/api/services')
      .then((response) => response.json() as Promise<ServiceRow[]>)
      .then((data) => { setServices(data); setLoadError(null); })
      .catch(() => { setServices([]); setLoadError('Não foi possível carregar os serviços.'); })
      .finally(() => setLoading(false));
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
    authFetch('http://127.0.0.1:3001/api/audiovisual-config')
      .then((response) => response.ok ? response.json() as Promise<AudiovisualConfig> : null)
      .then((config) => setAvConfig(config))
      .catch(() => setAvConfig(null));
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
      technicalNotes: service.technicalNotes || '',
      audiovisualMode: service.audiovisualMode,
      audiovisualMonthlyCve: service.audiovisualMonthlyCve ? String(service.audiovisualMonthlyCve) : '',
      audiovisualAnnualCve: service.audiovisualAnnualCve ? String(service.audiovisualAnnualCve) : ''
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
    setDeviceMode('install');
    setShareChoice('');
    void ensureCatalogLoaded();
    void loadShareableDevices();
    setShowDeviceDialog(true);
  }

  function closeDeviceDialog() {
    if (submitting) return;
    setShowDeviceDialog(false);
    setAddItemDrafts([]);
    setAddLaborCve('');
    setDeviceMode('install');
    setShareChoice('');
  }

  /** Antenas ativas de outros serviços, candidatas a servir também este cliente. */
  function loadShareableDevices() {
    return authFetch('http://127.0.0.1:3001/api/service-device-assignments')
      .then((response) => response.ok ? response.json() as Promise<ActiveAssignment[]> : [])
      .then(setShareableDevices)
      .catch(() => setShareableDevices([]));
  }

  /** Liga uma antena já instalada a este serviço. Não desconta stock. */
  async function submitShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedService || !shareChoice) {
      toast('Escolhe o equipamento a ligar.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/service-device-assignments/${shareChoice}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: selectedService.id })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel ligar o equipamento.', 'error');
        return;
      }
      toast('Equipamento passa a servir também este cliente.', 'success');
      closeDeviceDialog();
      await loadTechnicalHistory(selectedService.id);
      void loadServices();
    } catch {
      toast('Falha de rede ao ligar o equipamento.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  /** Corta a ligação a uma antena de que este serviço não é titular. */
  async function unshareDevice(assignment: DeviceAssignment) {
    if (!selectedService) return;
    const label = assignment.brand ? `${assignment.brand} ${assignment.model}` : assignment.model;
    if (!(await confirm({
      title: 'Desassociar equipamento',
      message: `Este serviço deixa de ser servido por ${label}. O equipamento continua instalado no serviço titular e o stock não é alterado.`,
      tone: 'danger',
      confirmLabel: 'Desassociar'
    }))) return;
    setSubmitting(true);
    try {
      const response = await authFetch(
        `http://127.0.0.1:3001/api/service-device-assignments/${assignment.id}/shares/${selectedService.id}`,
        { method: 'DELETE' }
      );
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel desassociar o equipamento.', 'error');
        return;
      }
      toast('Equipamento desassociado.', 'success');
      await loadTechnicalHistory(selectedService.id);
      void loadServices();
    } catch {
      toast('Falha de rede ao desassociar equipamento.', 'error');
    } finally {
      setSubmitting(false);
    }
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
      void loadServices();
    } catch {
      toast('Falha de rede ao adicionar itens.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // Apaga um serviço mal criado (bloqueado pelo backend se já houver faturas).
  async function deleteService(service: ServiceRow) {
    if (!(await confirm({
      title: 'Apagar serviço',
      message: `Apagar o serviço de ${service.clientName}? Esta ação é irreversível e o equipamento atribuído volta ao stock. Serviços já faturados não podem ser apagados — devem ser cancelados.`,
      tone: 'danger',
      confirmLabel: 'Apagar'
    }))) return;
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${service.id}`, {
        method: 'DELETE'
      });
      if (response.status === 409) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        toast(data.error || 'Serviço com faturas: cancele em vez de apagar.', 'error');
        return;
      }
      if (!response.ok) {
        toast('Nao foi possivel apagar o servico.', 'error');
        return;
      }
      toast('Servico apagado e stock reposto.', 'success');
      setSelectedService(null);
      await loadServices();
    } catch {
      toast('Falha de rede ao apagar o servico.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function returnDevice(assignment: DeviceAssignment) {
    if (!selectedService) return;
    const label = assignment.brand ? `${assignment.brand} ${assignment.model}` : assignment.model;
    if (!(await confirm({
      title: 'Remover equipamento',
      message: `Remover ${label}${assignment.serialNumber ? ` (${assignment.serialNumber})` : ''} deste serviço? O stock será reposto.`,
      tone: 'danger',
      confirmLabel: 'Remover'
    }))) return;
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/service-device-assignments/${assignment.id}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel remover o equipamento.', 'error');
        return;
      }
      toast('Equipamento removido e stock reposto.', 'success');
      await loadTechnicalHistory(selectedService.id);
      void loadServices();
    } catch {
      toast('Falha de rede ao remover equipamento.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function openReplaceDialog(assignment: DeviceAssignment) {
    setReplaceTarget(assignment);
    setReplaceDraft(emptyItemDraft('equipamento'));
    void ensureCatalogLoaded();
  }

  function closeReplaceDialog() {
    if (submitting) return;
    setReplaceTarget(null);
    setReplaceDraft(emptyItemDraft('equipamento'));
  }

  async function submitReplace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedService || !replaceTarget) return;
    if (!replaceDraft.catalogId) {
      toast('Selecione o equipamento de substituicao.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/service-device-assignments/${replaceTarget.id}/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalogId: Number(replaceDraft.catalogId),
          serialNumber: replaceDraft.serialNumber || null,
          assetTag: replaceDraft.assetTag || null,
          ipAddress: replaceDraft.ipAddress || null,
          macAddress: replaceDraft.macAddress || null,
          notes: replaceDraft.notes || null
        })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel substituir o equipamento.', 'error');
        return;
      }
      toast('Equipamento substituido.', 'success');
      setReplaceTarget(null);
      setReplaceDraft(emptyItemDraft('equipamento'));
      await loadTechnicalHistory(selectedService.id);
      void loadServices();
    } catch {
      toast('Falha de rede ao substituir equipamento.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function openEditDialog(assignment: DeviceAssignment) {
    setEditTarget(assignment);
    setEditDraft({
      ...emptyItemDraft('equipamento'),
      serialNumber: assignment.serialNumber || '',
      assetTag: assignment.assetTag || '',
      ipAddress: assignment.ipAddress || '',
      macAddress: assignment.macAddress || '',
      notes: assignment.notes || ''
    });
  }

  function closeEditDialog() {
    if (submitting) return;
    setEditTarget(null);
    setEditDraft(emptyItemDraft('equipamento'));
  }

  /** Corrige a identificação do equipamento instalado — não mexe no stock. */
  async function submitEditDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedService || !editTarget) return;
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/service-device-assignments/${editTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serialNumber: editDraft.serialNumber || null,
          assetTag: editDraft.assetTag || null,
          ipAddress: editDraft.ipAddress || null,
          macAddress: editDraft.macAddress || null,
          notes: editDraft.notes || null
        })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast(data.error || 'Nao foi possivel atualizar o equipamento.', 'error');
        return;
      }
      toast('Identificacao atualizada.', 'success');
      setEditTarget(null);
      setEditDraft(emptyItemDraft('equipamento'));
      await loadTechnicalHistory(selectedService.id);
      void loadServices();
    } catch {
      toast('Falha de rede ao atualizar equipamento.', 'error');
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
        audiovisualMode: form.audiovisualMode,
        audiovisualMonthlyCve: form.audiovisualMode === 'monthly' ? Number(form.audiovisualMonthlyCve || 0) : 0,
        audiovisualAnnualCve: form.audiovisualMode === 'annual' ? Number(form.audiovisualAnnualCve || 0) : 0,
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

  const visibleServices = services.filter((service) => {
    const normalizedSearch = search.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || service.clientName.toLowerCase().includes(normalizedSearch)
      || (service.planName || '').toLowerCase().includes(normalizedSearch)
      // Manutenção remota ao contrário: do IP da antena para o cliente.
      || (service.deviceIps || '').toLowerCase().includes(normalizedSearch);
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
        <div className="inline-actions">
          {canRecordTechnical && (
            <Button variant="secondary" onClick={() => setShowBulkIp(true)}>
              Atribuir IPs
            </Button>
          )}
          {canManageServices && (
            <Button onClick={openCreate}>
              Novo servico
            </Button>
          )}
        </div>
      </div>

      {showBulkIp && (
        <BulkIpDialog
          onClose={() => setShowBulkIp(false)}
          onSaved={() => { void loadServices(); }}
        />
      )}

      {loadError && services.length === 0 && <ErrorRetry message={loadError} onRetry={() => { void loadServices(); }} />}
      <FilterBar>
        <Field type="search" label="Buscar" aria-label="Pesquisar servicos" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cliente, plano ou IP" />
        <Select label="Estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | ServiceRow['status'])}>
          <option value="all">Todos</option>
          <option value="active">Ativos</option>
          <option value="suspended">Suspensos</option>
          <option value="cancelled">Cancelados</option>
        </Select>
        <Button variant="secondary" onClick={() => {
          setSearch('');
          setStatusFilter(DEFAULT_SERVICE_STATUS_FILTER);
        }}>
          Limpar filtros
        </Button>
        <small>{visibleServices.length} servicos</small>
      </FilterBar>

      {selectedService && (
        <ServiceDetailDialog
          service={selectedService}
          technicalHistory={technicalHistory}
          historyLoading={historyLoading}
          monthlyTotalCve={monthlyTotalCve(selectedService)}
          audiovisualLabel={avConfig?.label}
          canManage={canManageServices}
          canRecordTechnical={canRecordTechnical}
          submitting={submitting}
          onClose={() => setSelectedService(null)}
          onEdit={editService}
          onDelete={(service) => void deleteService(service)}
          onAddDevice={openDeviceDialog}
          onEditDevice={openEditDialog}
          onUnshareDevice={(assignment) => void unshareDevice(assignment)}
          onReplaceDevice={openReplaceDialog}
          onReturnDevice={(assignment) => void returnDevice(assignment)}
          onAddEvent={openEventDialog}
        />
      )}

      <div className="module-table">
        {loading && services.length === 0 && <SkeletonList rows={6} />}
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
            <code className="service-row-ip" title={service.deviceIps ? `IP dos equipamentos ativos: ${service.deviceIps}` : 'Sem IP registado'}>
              {service.deviceIps || '—'}
            </code>
            <small title={service.audiovisualMode === 'monthly' ? 'Mensalidade NET + TVM (canais e conteúdos audiovisuais)' : undefined}>
              {formatCve(monthlyTotalCve(service))}
              {service.audiovisualMode === 'monthly' && ' · NET + TVM'}
            </small>
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
        {!loading && visibleServices.length === 0 && (
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
              <option key={plan.id} value={plan.id}>{plan.name} - {formatCve(plan.monthlyPriceCve)}</option>
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

          {avConfig?.enabled && (
            <div className="service-items-builder">
              <Toggle
                title={avConfig.label}
                description="Mensal entra na fatura da internet; anual gera fatura própria."
                checked={form.audiovisualMode !== 'none'}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  audiovisualMode: event.target.checked ? 'monthly' : 'none',
                  audiovisualMonthlyCve: current.audiovisualMonthlyCve || String(avConfig.monthlyCve),
                  audiovisualAnnualCve: current.audiovisualAnnualCve || String(avConfig.annualCve)
                }))}
              />
              {form.audiovisualMode !== 'none' && (
                <>
                  <Select
                    label="Modalidade"
                    value={form.audiovisualMode}
                    onChange={(event) => updateForm('audiovisualMode', event.target.value)}
                  >
                    <option value="monthly">Mensal — na fatura da internet</option>
                    <option value="annual">Anual — fatura separada</option>
                  </Select>
                  {form.audiovisualMode === 'monthly' ? (
                    <Field
                      label="Valor mensal CVE"
                      required
                      type="number"
                      min={0}
                      value={form.audiovisualMonthlyCve}
                      onChange={(event) => updateForm('audiovisualMonthlyCve', event.target.value)}
                    />
                  ) : (
                    <Field
                      label="Valor anual CVE"
                      required
                      type="number"
                      min={0}
                      value={form.audiovisualAnnualCve}
                      onChange={(event) => updateForm('audiovisualAnnualCve', event.target.value)}
                    />
                  )}
                </>
              )}
            </div>
          )}

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
                  <ServiceItemDraftsBuilder drafts={itemDrafts} catalog={catalogList} onChange={setItemDrafts} ipPrefix={ipPrefix} />
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
              {submitting ? 'A gravar...' : deviceMode === 'share' ? 'Ligar' : 'Adicionar'}
            </Button>
          </>
        }
      >
        <div className="device-mode-switch" role="group" aria-label="Modo">
          <Button
            variant={deviceMode === 'install' ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={deviceMode === 'install'}
            onClick={() => setDeviceMode('install')}
          >
            Instalar novo
          </Button>
          <Button
            variant={deviceMode === 'share' ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={deviceMode === 'share'}
            onClick={() => setDeviceMode('share')}
          >
            Ligar equipamento existente
          </Button>
        </div>
        {deviceMode === 'install' ? (
          <form id="device-form" className="client-form" onSubmit={submitItems}>
            <ServiceItemDraftsBuilder drafts={addItemDrafts} catalog={catalogList} onChange={setAddItemDrafts} ipPrefix={ipPrefix} />
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
        ) : (
          <form id="device-form" className="client-form" onSubmit={submitShare}>
            <Message>
              Para um prédio com switch, ou uma antena com várias saídas de rede. Não desconta stock — a mesma antena
              passa a servir também este cliente, e o custo dela passa a ser dividido pelos serviços que serve.
            </Message>
            <Select
              wide
              label="Antena já instalada"
              required
              value={shareChoice}
              onChange={(event) => setShareChoice(event.target.value)}
            >
              <option value="">Selecionar equipamento</option>
              {shareableDevices
                .filter((device) => device.serviceId !== selectedService?.id)
                .map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.clientName} — {device.brand ? `${device.brand} ${device.model}` : device.model}
                    {device.ipAddress ? ` — ${device.ipAddress}` : ''}
                  </option>
                ))}
            </Select>
          </form>
        )}
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

      <Dialog
        open={replaceTarget !== null}
        onClose={closeReplaceDialog}
        eyebrow="Substituir equipamento"
        title={replaceTarget ? `Substituir ${replaceTarget.brand ? `${replaceTarget.brand} ${replaceTarget.model}` : replaceTarget.model}` : 'Substituir equipamento'}
        size="md"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeReplaceDialog} disabled={submitting}>Cancelar</Button>
            <Button type="submit" form="replace-form" loading={submitting}>
              {submitting ? 'A gravar...' : 'Substituir'}
            </Button>
          </>
        }
      >
        <form id="replace-form" className="client-form" onSubmit={submitReplace}>
          {replaceTarget && (
            <Message>
              O equipamento atual ({replaceTarget.serialNumber || replaceTarget.model}) será encerrado e o novo passa a ativo.
            </Message>
          )}
          <Select
            wide
            label="Novo equipamento"
            required
            value={replaceDraft.catalogId}
            onChange={(event) => setReplaceDraft((current) => ({ ...current, catalogId: event.target.value }))}
          >
            <option value="">Selecionar equipamento</option>
            {catalogList.filter((item) => item.category === 'equipamento').map((item) => (
              <option key={item.id} value={item.id} disabled={item.stockTotal < 1}>
                {item.brand ? `${item.brand} ${item.model}` : item.model} - {item.type} - {item.stockTotal} {item.unitOfMeasure}
              </option>
            ))}
          </Select>
          <Field label="Serial" value={replaceDraft.serialNumber} onChange={(event) => setReplaceDraft((current) => ({ ...current, serialNumber: event.target.value }))} />
          <Field label="Asset tag" value={replaceDraft.assetTag} onChange={(event) => setReplaceDraft((current) => ({ ...current, assetTag: event.target.value }))} />
          <Field label="MAC" value={replaceDraft.macAddress} onChange={(event) => setReplaceDraft((current) => ({ ...current, macAddress: event.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" />
          {takesStaticIp(catalogList.find((item) => String(item.id) === replaceDraft.catalogId)?.type) && (
            <IpField value={replaceDraft.ipAddress} prefix={ipPrefix} onChange={(ipAddress) => setReplaceDraft((current) => ({ ...current, ipAddress }))} />
          )}
          <Field wide label="Notas" value={replaceDraft.notes} onChange={(event) => setReplaceDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Motivo da substituicao" />
        </form>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={closeEditDialog}
        eyebrow="Editar equipamento"
        title={editTarget ? (editTarget.brand ? `${editTarget.brand} ${editTarget.model}` : editTarget.model) : 'Editar equipamento'}
        size="md"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeEditDialog} disabled={submitting}>Cancelar</Button>
            <Button type="submit" form="edit-device-form" loading={submitting}>
              {submitting ? 'A gravar...' : 'Guardar'}
            </Button>
          </>
        }
      >
        <form id="edit-device-form" className="client-form" onSubmit={submitEditDevice}>
          <Message>
            Corrige a identificação do equipamento instalado. O stock não é alterado e a atribuição mantém-se ativa.
          </Message>
          {/* Routers apanham IP dinamico; mostra na mesma se a linha ja trouxer um IP para o poder limpar. */}
          {(takesStaticIp(editTarget?.catalogType) || editDraft.ipAddress) && (
            <IpField value={editDraft.ipAddress} prefix={ipPrefix} onChange={(ipAddress) => setEditDraft((current) => ({ ...current, ipAddress }))} />
          )}
          <Field label="MAC" value={editDraft.macAddress} onChange={(event) => setEditDraft((current) => ({ ...current, macAddress: event.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" />
          <Field label="Serial" value={editDraft.serialNumber} onChange={(event) => setEditDraft((current) => ({ ...current, serialNumber: event.target.value }))} />
          <Field label="Asset tag" value={editDraft.assetTag} onChange={(event) => setEditDraft((current) => ({ ...current, assetTag: event.target.value }))} />
          <Field wide label="Notas" value={editDraft.notes} onChange={(event) => setEditDraft((current) => ({ ...current, notes: event.target.value }))} />
        </form>
      </Dialog>
    </section>
  );
}
