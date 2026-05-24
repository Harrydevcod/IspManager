import { ClipboardList, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { CSSProperties, DragEvent, FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Field, Message, Select, Textarea, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import './WorkOrdersModule.css';
import type {
  ServiceEventType,
  ServiceRow,
  WorkOrder,
  WorkOrderBoard,
  WorkOrderPriority,
  WorkOrderStatus
} from '../types';

const STATUSES: WorkOrderStatus[] = ['aguarda', 'agendada', 'em_curso', 'concluida', 'cancelada'];

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  aguarda: 'Aguarda',
  agendada: 'Agendada',
  em_curso: 'Em curso',
  concluida: 'Concluida',
  cancelada: 'Cancelada'
};

const PRIORITY_LABEL: Record<WorkOrderPriority, string> = {
  baixa: 'Baixa',
  media: 'Media',
  alta: 'Alta'
};

const PRIORITY_TAG: Record<WorkOrderPriority, string> = {
  alta: 'P1',
  media: 'P2',
  baixa: 'P3'
};

const EVENT_LABEL: Record<ServiceEventType, string> = {
  instalacao: 'Instalacao',
  manutencao: 'Manutencao',
  troca_equipamento: 'Troca de equipamento',
  visita: 'Visita',
  alteracao_servico: 'Alteracao de servico'
};

function formatDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
}

function formatRelative(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return null;
  const diffDays = Math.round((parsed.getTime() - Date.now()) / 86400000);
  if (diffDays === 0) return 'hoje';
  if (diffDays === 1) return 'amanha';
  if (diffDays === -1) return 'ontem';
  if (diffDays > 1 && diffDays <= 7) return `em ${diffDays} dias`;
  if (diffDays < -1 && diffDays >= -7) return `ha ${Math.abs(diffDays)} dias`;
  return parsed.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
}

function osIdentifier(id: number): string {
  return `OS-${String(id).padStart(3, '0')}`;
}

type FormState = {
  serviceId: string;
  title: string;
  description: string;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  eventType: '' | ServiceEventType;
  assignedTo: string;
  scheduledAt: string;
  completionNotes: string;
};

function emptyForm(): FormState {
  return {
    serviceId: '',
    title: '',
    description: '',
    status: 'aguarda',
    priority: 'media',
    eventType: '',
    assignedTo: '',
    scheduledAt: '',
    completionNotes: ''
  };
}

function toFormState(order: WorkOrder): FormState {
  return {
    serviceId: order.serviceId ? String(order.serviceId) : '',
    title: order.title,
    description: order.description ?? '',
    status: order.status,
    priority: order.priority,
    eventType: order.eventType ?? '',
    assignedTo: order.assignedTo ?? '',
    scheduledAt: order.scheduledAt ? order.scheduledAt.slice(0, 16).replace(' ', 'T') : '',
    completionNotes: order.completionNotes ?? ''
  };
}

export function WorkOrdersModule() {
  const { toast } = useToast();
  const auth = useAuth();
  const canDeleteWorkOrders = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const [board, setBoard] = useState<WorkOrderBoard | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<WorkOrder | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<WorkOrderStatus | null>(null);

  function loadBoard() {
    return authFetch('http://127.0.0.1:3001/api/work-orders/board')
      .then((res) => res.json() as Promise<WorkOrderBoard>)
      .then(setBoard)
      .catch(() => setBoard(null));
  }

  function ensureServicesLoaded() {
    if (services.length > 0) return Promise.resolve();
    return authFetch('http://127.0.0.1:3001/api/services')
      .then((res) => res.json() as Promise<ServiceRow[]>)
      .then(setServices)
      .catch(() => setServices([]));
  }

  useEffect(() => {
    void loadBoard();
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    void ensureServicesLoaded();
    setShowForm(true);
  }

  function openEdit(order: WorkOrder) {
    setEditing(order);
    setForm(toFormState(order));
    void ensureServicesLoaded();
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setForm(emptyForm());
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!form.title.trim()) {
      toast('Titulo obrigatorio.', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        status: form.status,
        priority: form.priority,
        assignedTo: form.assignedTo.trim() || null,
        scheduledAt: form.scheduledAt ? form.scheduledAt.replace('T', ' ') : null,
        eventType: form.eventType || null,
        serviceId: form.serviceId ? Number(form.serviceId) : null
      };
      if (editing) {
        payload.completionNotes = form.completionNotes.trim() || null;
      }

      const url = editing
        ? `http://127.0.0.1:3001/api/work-orders/${editing.id}`
        : 'http://127.0.0.1:3001/api/work-orders';
      const response = await authFetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        toast(data.error || 'Nao foi possivel guardar a OS.', 'error');
        return;
      }

      toast(editing ? 'OS atualizada.' : 'OS criada.', 'success');
      closeForm();
      await loadBoard();
    } finally {
      setSubmitting(false);
    }
  }

  async function removeOrder(order: WorkOrder) {
    if (!confirm(`Eliminar OS "${order.title}"?`)) return;
    const response = await authFetch(`http://127.0.0.1:3001/api/work-orders/${order.id}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      toast('Nao foi possivel eliminar.', 'error');
      return;
    }
    toast('OS eliminada.', 'success');
    closeForm();
    await loadBoard();
  }

  async function patchStatus(order: WorkOrder, status: WorkOrderStatus) {
    if (order.status === status) return;
    if (status === 'concluida' && order.serviceId && !order.eventType) {
      toast('Define o tipo de evento antes de concluir (Editar a OS).', 'info');
      return;
    }
    const response = await authFetch(`http://127.0.0.1:3001/api/work-orders/${order.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!response.ok) {
      toast('Nao foi possivel mover a OS.', 'error');
      return;
    }
    if (status === 'concluida') {
      toast('OS concluida — registo tecnico criado.', 'success');
    } else {
      toast(`Movida para "${STATUS_LABEL[status]}".`, 'success');
    }
    await loadBoard();
  }

  function handleDragStart(event: DragEvent<HTMLElement>, order: WorkOrder) {
    setDragId(order.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(order.id));
  }

  function handleDragEnd() {
    setDragId(null);
    setDragOverStatus(null);
  }

  function handleColumnDragOver(event: DragEvent<HTMLDivElement>, status: WorkOrderStatus) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverStatus(status);
  }

  function handleColumnDragLeave(status: WorkOrderStatus) {
    setDragOverStatus((current) => (current === status ? null : current));
  }

  async function handleColumnDrop(event: DragEvent<HTMLDivElement>, status: WorkOrderStatus) {
    event.preventDefault();
    setDragOverStatus(null);
    const id = Number(event.dataTransfer.getData('text/plain')) || dragId;
    setDragId(null);
    if (!id || !board) return;
    const order = board.columns.flatMap((c) => c.items).find((o) => o.id === id);
    if (!order) return;
    await patchStatus(order, status);
  }

  const totals = board?.totals;
  const columns = useMemo(() => {
    if (!board) return [];
    return board.columns.map((col) => ({ ...col, label: STATUS_LABEL[col.status] }));
  }, [board]);

  return (
    <section className="module-panel">
      <div className="module-header workorders-header">
        <div>
          <p className="eyebrow">Operacao tecnica</p>
          <h2>OS no terreno</h2>
          {totals && (
            <p className="workorders-summary">
              <span className="workorders-summary-figure">{String(totals.open).padStart(2, '0')}</span>
              <span>em aberto</span>
              <span className="workorders-summary-divider" aria-hidden>/</span>
              <span>{totals.total} total</span>
            </p>
          )}
        </div>
        <div className="inline-actions">
          <Button size="sm" leadingIcon={<Plus size={14} aria-hidden />} onClick={openCreate}>
            Nova OS
          </Button>
        </div>
      </div>

      {!board && <Message>A carregar...</Message>}

      {board && (
        <div className="kanban-board" role="list">
          {columns.map((col) => {
            const isClosed = col.status === 'concluida' || col.status === 'cancelada';
            return (
              <div
                key={col.status}
                className={`kanban-column kanban-${col.status}${isClosed ? ' kanban-closed' : ''}${dragOverStatus === col.status ? ' drag-over' : ''}`}
                onDragOver={(event) => handleColumnDragOver(event, col.status)}
                onDragLeave={() => handleColumnDragLeave(col.status)}
                onDrop={(event) => handleColumnDrop(event, col.status)}
                role="listitem"
                aria-label={`${col.label} — ${col.items.length} OS`}
              >
                <header className="kanban-head">
                  <h3>{col.label.toLowerCase()}</h3>
                  <span className="kanban-count" aria-hidden>{col.items.length.toString().padStart(2, '0')}</span>
                </header>
                <div className="kanban-body">
                  {col.items.length === 0 && (
                    <div className="kanban-empty" aria-hidden>
                      <span className="kanban-empty-mark">+</span>
                      <p>arrasta para aqui</p>
                    </div>
                  )}
                  {col.items.map((order, index) => {
                    const relative = formatRelative(order.scheduledAt);
                    const metaParts: string[] = [];
                    if (relative) metaParts.push(relative);
                    else if (order.scheduledAt) metaParts.push(formatDate(order.scheduledAt) ?? '');
                    if (order.assignedTo) metaParts.push(order.assignedTo);
                    if (order.eventType) metaParts.push(EVENT_LABEL[order.eventType].toLowerCase());
                    return (
                      <article
                        key={order.id}
                        className={`kanban-card priority-${order.priority}${dragId === order.id ? ' dragging' : ''}`}
                        style={{ ['--i' as never]: index } as CSSProperties}
                        draggable
                        onDragStart={(event) => handleDragStart(event, order)}
                        onDragEnd={handleDragEnd}
                        onClick={() => openEdit(order)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openEdit(order);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`Editar ${osIdentifier(order.id)} — ${order.title}`}
                      >
                        <div className="kanban-card-rail">
                          <span className="kanban-card-id">{osIdentifier(order.id)}</span>
                          <span
                            className="kanban-card-priority"
                            data-priority={order.priority}
                            title={PRIORITY_LABEL[order.priority]}
                          >
                            {PRIORITY_TAG[order.priority]}
                          </span>
                          {canDeleteWorkOrders && (
                            <Button
                              variant="icon"
                              size="sm"
                              className="kanban-card-remove"
                              aria-label={`Eliminar ${osIdentifier(order.id)}`}
                              title="Eliminar"
                              onClick={(event) => {
                                event.stopPropagation();
                                void removeOrder(order);
                              }}
                            >
                              <X size={12} aria-hidden />
                            </Button>
                          )}
                        </div>
                        <h4 className="kanban-card-title">{order.title}</h4>
                        {order.clientName && (
                          <p className="kanban-card-client">
                            {order.clientCode && <span className="entity-code kanban-card-code">{order.clientCode}</span>}
                            <span className="kanban-card-client-name">{order.clientName}</span>
                          </p>
                        )}
                        {metaParts.length > 0 && (
                          <p className="kanban-card-meta">{metaParts.join(' · ')}</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={showForm}
        onClose={closeForm}
        eyebrow={editing ? 'Editar OS' : 'Nova OS'}
        title={editing ? `OS #${editing.id}` : 'OS tecnica'}
        size="md"
        actions={
          <>
            {editing && canDeleteWorkOrders && (
              <Button variant="danger" leadingIcon={<Trash2 size={14} aria-hidden />} onClick={() => removeOrder(editing)}>
                Eliminar
              </Button>
            )}
            <Button variant="secondary" onClick={closeForm}>Cancelar</Button>
            <Button type="submit" form="work-order-form" loading={submitting} leadingIcon={!submitting ? <Pencil size={14} aria-hidden /> : undefined}>
              {editing ? 'Guardar' : 'Criar'}
            </Button>
          </>
        }
      >
        <form id="work-order-form" onSubmit={submitForm} className="client-form">
          <Field label="Titulo" type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={140} />

          <Textarea label="Descricao" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />

          <Select label="Servico" value={form.serviceId} onChange={(event) => setForm({ ...form, serviceId: event.target.value })}>
            <option value="">(sem servico associado)</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                #{service.id} - {service.clientName}
              </option>
            ))}
          </Select>

          <Select label="Tipo de evento" value={form.eventType} onChange={(event) => setForm({ ...form, eventType: event.target.value as FormState['eventType'] })}>
            <option value="">(nao definido)</option>
            {(Object.keys(EVENT_LABEL) as ServiceEventType[]).map((type) => (
              <option key={type} value={type}>
                {EVENT_LABEL[type]}
              </option>
            ))}
          </Select>

          <Select label="Estado" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as WorkOrderStatus })}>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </Select>

          <Select label="Prioridade" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as WorkOrderPriority })}>
            {(Object.keys(PRIORITY_LABEL) as WorkOrderPriority[]).map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABEL[priority]}
              </option>
            ))}
          </Select>

          <Field label="Agenda" type="datetime-local" value={form.scheduledAt} onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} />

          <Field label="Tecnico" type="text" value={form.assignedTo} onChange={(event) => setForm({ ...form, assignedTo: event.target.value })} placeholder="Nome do tecnico" />

          {editing && (
            <Textarea
              label="Notas de conclusao"
              rows={2}
              value={form.completionNotes}
              onChange={(event) => setForm({ ...form, completionNotes: event.target.value })}
              placeholder="Detalhes adicionais (passa para o registo tecnico quando concluida)"
            />
          )}
        </form>
      </Dialog>
    </section>
  );
}

export const WORK_ORDERS_ICON = ClipboardList;
