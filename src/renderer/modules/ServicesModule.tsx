import { Network, Pencil, Plus, Wrench } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Combobox, Dialog, EmptyState, ErrorRetry, Field, FilterBar, Message, ModuleHeaderActions, Select, SkeletonList, Textarea, Toggle, useConfirm, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { formatCve } from '../lib/format';
import { labelForType, requiresStaticIp } from '../../shared/equipment';
import { suggestIpPrefix } from '../lib/ip';
import { statusLabel, statusTone } from '../lib/status';
import { hasTextSelection } from '../lib/textSelection';
import type { AudiovisualConfig, Client, DeviceAssignment, ManualServiceEventType, PlanRow, ReturnCondition, ServiceRow, StockCatalogRow, StockSummary, TechnicalHistory } from '../types';
import { BulkIpDialog, type ActiveAssignment } from './services/BulkIpDialog';
import { findReplaceTarget } from './services/findReplaceTarget';
import { IpField } from './services/IpField';
import { MANUAL_EVENT_TYPES, ServiceDetailDialog, eventTypeLabel } from './services/ServiceDetailDialog';
import { PurchaseDeviceDialog } from './services/PurchaseDeviceDialog';
import { ServiceReturnDialog } from './services/ServiceReturnDialog';
import { DeviceOwnerDialog, type PromoteOwnerResult } from './services/DeviceOwnerDialog';
import { TransferServiceDialog, type TransferResult } from './services/TransferServiceDialog';
import { ServiceItemDraftsBuilder, emptyItemDraft, type ItemDraft } from './services/ServiceItemDraftsBuilder';

type EventFormState = {
  eventType: ManualServiceEventType;
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
  pppoeUsername: string;
  pppoePassword: string;
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
    pppoeUsername: '',
    pppoePassword: '',
    audiovisualMode: 'none',
    audiovisualMonthlyCve: '',
    audiovisualAnnualCve: ''
  };
}

const DEFAULT_SERVICE_STATUS_FILTER: 'all' | ServiceRow['status'] = 'active';

export function ServicesModule({
  focusClientId,
  focusServiceId,
  focusAssignmentId,
  onFocusHandled
}: {
  focusClientId?: number | null;
  focusServiceId?: number | null;
  /** Vem da Descoberta: qual equipamento do serviço é que se vai substituir. */
  focusAssignmentId?: number | null;
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
  const [ownerTarget, setOwnerTarget] = useState<DeviceAssignment | null>(null);
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
  /**
   * O equipamento que a Descoberta mandou substituir, à espera da lista.
   *
   * O `focusServiceId` abre o serviço, mas as atribuições só chegam no pedido
   * seguinte (`loadTechnicalHistory`) — por isso a abertura é em dois tempos:
   * aqui guarda-se a intenção, e o efeito lá em baixo executa-a quando houver
   * lista onde procurar.
   */
  const [pendingReplaceId, setPendingReplaceId] = useState<number | null>(null);
  const [purchaseTarget, setPurchaseTarget] = useState<DeviceAssignment | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  /** Painel de devolução: serviço + histórico no momento em que abriu. */
  const [returnTarget, setReturnTarget] = useState<
    { service: ServiceRow; history: TechnicalHistory; focusAssignmentId: number | null } | null
  >(null);
  const [returnError, setReturnError] = useState<string | null>(null);
  /** Serviço a mudar de titular: a casa mudou de inquilino ou o material vai para outro sítio. */
  const [transferTarget, setTransferTarget] = useState<ServiceRow | null>(null);
  const [replaceDraft, setReplaceDraft] = useState<ItemDraft>(emptyItemDraft('equipamento'));
  const [editTarget, setEditTarget] = useState<DeviceAssignment | null>(null);
  const [editDraft, setEditDraft] = useState<ItemDraft>(emptyItemDraft('equipamento'));
  /** Fora do `ItemDraft` porque este é o aluguer desta atribuição, não do modelo. */
  const [editRental, setEditRental] = useState('0');
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
      pppoeUsername: service.pppoeUsername || '',
      pppoePassword: service.pppoePassword || '',
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

  async function loadTechnicalHistory(serviceId: number): Promise<TechnicalHistory> {
    const empty: TechnicalHistory = {
      serviceId, assignments: [], materials: [], materialReturns: [], installCosts: [], events: []
    };
    setHistoryLoading(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${serviceId}/technical-history`);
      if (!response.ok) {
        setTechnicalHistory(empty);
        return empty;
      }
      const data = await response.json() as TechnicalHistory;
      setTechnicalHistory(data);
      return data;
    } catch {
      setTechnicalHistory(empty);
      return empty;
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
    if (focusServiceId && services.length > 0) {
      const service = services.find((candidate) => candidate.id === focusServiceId);
      if (service) {
        setSearch(service.clientName);
        setStatusFilter('all');
        setSelectedService(service);
        setPendingReplaceId(focusAssignmentId ?? null);
      }
      onFocusHandled?.();
      return;
    }
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
  }, [focusClientId, focusServiceId, focusAssignmentId, services, onFocusHandled]);

  /**
   * Segundo tempo do atalho da Descoberta: a lista chegou, abre-se o diálogo.
   *
   * A confirmação do `serviceId` não é zelo a mais: o `technicalHistory` guarda
   * a lista do serviço **anterior** até o pedido novo voltar, e sem ela o atalho
   * procurava o equipamento na lista errada — e desistia por não o encontrar.
   *
   * A intenção limpa-se dispare ou não: se o equipamento já não existe, ou a
   * permissão não chega, quem chegou aqui fica no serviço em foco — que
   * continua a ser o sítio certo — e não com um atalho a tentar outra vez.
   */
  useEffect(() => {
    if (pendingReplaceId === null) return;
    if (!selectedService || technicalHistory?.serviceId !== selectedService.id) return;
    const target = findReplaceTarget(technicalHistory.assignments, pendingReplaceId, canRecordTechnical);
    setPendingReplaceId(null);
    if (target) openReplaceDialog(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReplaceId, selectedService, technicalHistory, canRecordTechnical]);

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
              notes: draft.notes || null,
              ownership: draft.ownership
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

  /**
   * Depois da transferência o serviço é de outro titular, por isso a lista e o
   * detalhe aberto ficam desatualizados. Os avisos do servidor (sem equipamento,
   * IP por definir) valem um toast — são a próxima tarefa do técnico.
   */
  async function finishTransfer(result: TransferResult) {
    toast(`Servico transferido para ${result.toClient.name}.`, 'success');
    for (const warning of result.warnings) toast(warning, 'info');
    setSelectedService(null);
    await loadServices();
  }

  /**
   * A antena mudou de dono: o serviço aberto pode ter passado a titular ou
   * deixado de o ser, por isso o histórico técnico tem de voltar da BD.
   */
  async function finishPromoteOwner(result: PromoteOwnerResult) {
    toast(`Titularidade da antena passou para ${result.toClientName}.`, 'success');
    if (selectedService) await loadTechnicalHistory(selectedService.id);
    await loadServices();
  }

  /** Há alguma coisa em casa do cliente por fechar? */
  function hasPendingReturns(history: TechnicalHistory) {
    const devices = history.assignments.filter((a) => !a.endDate && a.isOwner && a.ownership === 'isp');
    const materials = history.materialReturns.filter((m) => m.consumed - m.recovered > 0);
    return devices.length + materials.length > 0;
  }

  /**
   * Abre o painel de devolução. No cancelamento entra sozinho (`onlyIfPending`),
   * e cala-se quando não há nada por devolver — não vale um modal vazio.
   */
  async function openReturns(
    service: ServiceRow,
    options: { focusAssignmentId?: number | null; onlyIfPending?: boolean } = {}
  ) {
    const history = technicalHistory?.serviceId === service.id
      ? technicalHistory
      : await loadTechnicalHistory(service.id);
    if (options.onlyIfPending && !hasPendingReturns(history)) return;
    setReturnError(null);
    setReturnTarget({ service, history, focusAssignmentId: options.focusAssignmentId ?? null });
  }

  async function submitReturns(payload: {
    devices: Array<{ assignmentId: number; condition: ReturnCondition }>;
    materials: Array<{ catalogId: number; quantity: number }>;
    notes: string | null;
  }) {
    if (!returnTarget) return;
    setSubmitting(true);
    setReturnError(null);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/services/${returnTarget.service.id}/returns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        setReturnError(data.error || 'Não foi possível registar a devolução.');
        return;
      }
      const backToStock = payload.devices.filter((device) => device.condition === 'bom').length;
      toast(
        backToStock === payload.devices.length
          ? 'Devolução registada e stock reposto.'
          : `Devolução registada. ${backToStock} de volta ao stock, ${payload.devices.length - backToStock} como perda.`,
        'success'
      );
      setReturnTarget(null);
      await loadTechnicalHistory(returnTarget.service.id);
      void loadServices();
    } catch {
      setReturnError('Falha de rede ao registar a devolucao.');
    } finally {
      setSubmitting(false);
    }
  }

  async function purchaseDevice(amountCve: number, notes: string | null) {
    if (!selectedService || !purchaseTarget) return;
    setSubmitting(true);
    setPurchaseError(null);
    try {
      const response = await authFetch(
        `http://127.0.0.1:3001/api/service-device-assignments/${purchaseTarget.id}/purchase`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountCve, notes })
        }
      );
      const data = await response.json() as { error?: string; paymentId?: number | null };
      if (!response.ok) {
        setPurchaseError(data.error || 'Nao foi possivel registar a compra.');
        return;
      }
      toast(
        data.paymentId
          ? 'Compra registada. A cobranca foi emitida e o aluguer para na proxima fatura.'
          : 'Equipamento passou a ser do cliente. O aluguer para na proxima fatura.',
        'success'
      );
      setPurchaseTarget(null);
      await loadTechnicalHistory(selectedService.id);
      void loadServices();
    } catch {
      setPurchaseError('Falha de rede ao registar a compra.');
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
    setEditRental(String(assignment.rentalFeeCve ?? 0));
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
          notes: editDraft.notes || null,
          // Só do ISP tem aluguer; do cliente o servidor recusa e faz bem.
          ...(editTarget.ownership === 'isp' ? { rentalFeeCve: Number(editRental) || 0 } : {})
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
        pppoeUsername: form.pppoeUsername,
        pppoePassword: form.pppoePassword,
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
    // O cancelamento é o momento em que o material volta. Abrir o painel aqui é
    // a diferença entre fechar o serviço e ficar com uma antena perdida na rua.
    const cancelled = Boolean(editingService) && form.status === 'cancelled' && editingService?.status !== 'cancelled';
    const cancelledService = editingService ? { ...editingService, status: 'cancelled' as const } : null;
    closeForm();
    await loadServices();
    if (cancelled && cancelledService && canRecordTechnical) {
      await openReturns(cancelledService, { onlyIfPending: true });
    }
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
        {(canRecordTechnical || canManageServices) && (
          <ModuleHeaderActions
            ariaLabel="Ações de serviços"
            secondary={canRecordTechnical ? (
              <Button variant="secondary" leadingIcon={<Network size={16} aria-hidden />} onClick={() => setShowBulkIp(true)}>
                Identificar equipamentos
              </Button>
            ) : undefined}
            primary={canManageServices ? (
              <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={openCreate}>
                Novo servico
              </Button>
            ) : undefined}
          />
        )}
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

      {transferTarget && (
        <TransferServiceDialog
          service={transferTarget}
          onClose={() => setTransferTarget(null)}
          onDone={(result) => { setTransferTarget(null); void finishTransfer(result); }}
        />
      )}

      {selectedService && ownerTarget && (
        <DeviceOwnerDialog
          assignment={ownerTarget}
          currentServiceId={selectedService.id}
          currentClientName={selectedService.clientName}
          onClose={() => setOwnerTarget(null)}
          onDone={(result) => { setOwnerTarget(null); void finishPromoteOwner(result); }}
        />
      )}

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
          onPromoteOwner={setOwnerTarget}
          onReplaceDevice={openReplaceDialog}
          onReturnDevice={(assignment) => void openReturns(selectedService, { focusAssignmentId: assignment.id })}
          onOpenReturns={() => void openReturns(selectedService)}
          onPurchaseDevice={(assignment) => { setPurchaseError(null); setPurchaseTarget(assignment); }}
          onAddEvent={openEventDialog}
          onTransfer={() => setTransferTarget(selectedService)}
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
            onClick={() => { if (!hasTextSelection()) setSelectedService(service); }}
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
          <Field
            label="Utilizador PPPoE"
            value={form.pppoeUsername}
            onChange={(event) => updateForm('pppoeUsername', event.target.value)}
            hint="Identidade deste cliente no router. Em branco, o serviço fica fora do controlo de acesso."
          />
          <Field
            label="Senha PPPoE"
            value={form.pppoePassword}
            onChange={(event) => updateForm('pppoePassword', event.target.value)}
            hint="É esta que o cliente configura no equipamento dele."
          />
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
          <Select wide label="Tipo de evento" required value={eventForm.eventType} onChange={(event) => setEventForm((c) => ({ ...c, eventType: event.target.value as ManualServiceEventType }))}>
            {MANUAL_EVENT_TYPES.map((key) => (
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
                {item.brand ? `${item.brand} ${item.model}` : item.model} - {labelForType(item.type)} - {item.stockTotal} {item.unitOfMeasure}
              </option>
            ))}
          </Select>
          <Field label="Serial" value={replaceDraft.serialNumber} onChange={(event) => setReplaceDraft((current) => ({ ...current, serialNumber: event.target.value }))} />
          <Field label="Asset tag" value={replaceDraft.assetTag} onChange={(event) => setReplaceDraft((current) => ({ ...current, assetTag: event.target.value }))} />
          <Field label="MAC" value={replaceDraft.macAddress} onChange={(event) => setReplaceDraft((current) => ({ ...current, macAddress: event.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" />
          <IpField
            value={replaceDraft.ipAddress}
            prefix={ipPrefix}
            required={requiresStaticIp(catalogList.find((item) => String(item.id) === replaceDraft.catalogId)?.type)}
            onChange={(ipAddress) => setReplaceDraft((current) => ({ ...current, ipAddress }))}
          />
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
          <IpField
            value={editDraft.ipAddress}
            prefix={ipPrefix}
            required={requiresStaticIp(editTarget?.catalogType)}
            onChange={(ipAddress) => setEditDraft((current) => ({ ...current, ipAddress }))}
          />
          <Field label="MAC" value={editDraft.macAddress} onChange={(event) => setEditDraft((current) => ({ ...current, macAddress: event.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" />
          <Field label="Serial" value={editDraft.serialNumber} onChange={(event) => setEditDraft((current) => ({ ...current, serialNumber: event.target.value }))} />
          <Field label="Asset tag" value={editDraft.assetTag} onChange={(event) => setEditDraft((current) => ({ ...current, assetTag: event.target.value }))} />
          {/* Equipamento do cliente não gera renda, por isso o campo nem aparece. */}
          {editTarget?.ownership === 'isp' && (
            <Field
              label="Aluguer / mês"
              type="number"
              min="0"
              step="50"
              value={editRental}
              onChange={(event) => setEditRental(event.target.value)}
              hint="Vale a partir da próxima fatura; as já emitidas não mudam"
            />
          )}
          <Field wide label="Notas" value={editDraft.notes} onChange={(event) => setEditDraft((current) => ({ ...current, notes: event.target.value }))} />
        </form>
      </Dialog>

      {returnTarget && (
        <ServiceReturnDialog
          clientName={returnTarget.service.clientName}
          assignments={returnTarget.history.assignments}
          materialReturns={returnTarget.history.materialReturns}
          focusAssignmentId={returnTarget.focusAssignmentId}
          submitting={submitting}
          error={returnError}
          onClose={() => setReturnTarget(null)}
          onConfirm={(payload) => void submitReturns(payload)}
        />
      )}

      {purchaseTarget && (
        <PurchaseDeviceDialog
          assignment={purchaseTarget}
          submitting={submitting}
          error={purchaseError}
          onClose={() => setPurchaseTarget(null)}
          onConfirm={(amountCve, notes) => void purchaseDevice(amountCve, notes)}
        />
      )}
    </section>
  );
}
