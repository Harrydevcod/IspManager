import './SupportModule.css';

import { CheckCircle2, Clock, Hourglass, LifeBuoy, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, DataTable, EmptyState, ErrorRetry, MetricCard, MetricGrid, ModuleHeaderActions, Select, SkeletonList,
  type DataTableColumn
} from '../../components';
import { useAuth } from '../../lib/auth';
import { NewTicketDialog } from './NewTicketDialog';
import { TicketDialog } from './TicketDialog';
import {
  CATEGORY_LABEL, CHANNEL_LABEL, PRIORITY_LABEL, STATUS_LABEL, STATUS_TONE, durationLabel, sinceLabel, ticketsRequest,
  type Assignee, type Ticket, type TicketList, type TicketStatus
} from './support-api';

const PRIORITY_ORDER = { alta: 0, media: 1, baixa: 2 } as const;
const STATUS_ORDER: Record<TicketStatus, number> = { aberto: 0, em_curso: 1, aguarda_cliente: 2, resolvido: 3, fechado: 4 };

const columns: DataTableColumn<Ticket>[] = [
  { header: 'Nº', sortValue: (row) => row.id, defaultDirection: 'desc', cell: (row) => row.id },
  { header: 'Estado', sortValue: (row) => STATUS_ORDER[row.status], cell: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge> },
  { header: 'Prioridade', sortValue: (row) => PRIORITY_ORDER[row.priority], cell: (row) => PRIORITY_LABEL[row.priority] },
  { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => <strong>{row.clientName}</strong> },
  { header: 'Assunto', sortValue: (row) => row.subject, cell: (row) => row.subject },
  { header: 'Categoria', sortValue: (row) => CATEGORY_LABEL[row.category], cell: (row) => CATEGORY_LABEL[row.category] },
  { header: 'Canal', sortValue: (row) => CHANNEL_LABEL[row.channel], cell: (row) => CHANNEL_LABEL[row.channel] },
  { header: 'Técnico', sortValue: (row) => row.assignedToName ?? '', cell: (row) => row.assignedToName ?? '—' },
  { header: 'Aberto', sortValue: (row) => row.openedAt, defaultDirection: 'desc', cell: (row) => sinceLabel(row.openedAt) }
];

export function SupportModule() {
  const { user } = useAuth();
  const canWrite = !user || ['admin', 'operator', 'technician'].includes(user.role);
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [data, setData] = useState<TicketList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(() => {
    setError(null);
    ticketsRequest<TicketList>(status ? `?status=${status}` : '')
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [status]);

  useEffect(load, [load]);
  useEffect(() => {
    ticketsRequest<Assignee[]>('/assignees').then(setAssignees).catch(() => setAssignees([]));
  }, []);

  const metrics = data?.metrics;
  return (
    <section className="module-panel support-module">
      <div className="module-header">
        <div>
          <p className="eyebrow">Assistência</p>
          <h2>Pedidos dos clientes</h2>
        </div>
        <ModuleHeaderActions ariaLabel="Ações dos pedidos de assistência"
          primary={canWrite ? <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={() => setCreating(true)}>Novo pedido</Button> : undefined} />
      </div>

      {metrics && (
        <MetricGrid label="Resumo da assistência">
          <MetricCard icon={LifeBuoy} label="Abertos" value={String(metrics.open)} tone={metrics.open > 0 ? 'danger' : 'neutral'}
            onActivate={() => setStatus('aberto')} />
          <MetricCard icon={Hourglass} label="A aguardar o cliente" value={String(metrics.waiting)} onActivate={() => setStatus('aguarda_cliente')} />
          <MetricCard icon={CheckCircle2} label="Resolvidos este mês" value={String(metrics.resolvedThisMonth)} />
          <MetricCard icon={Clock} label="1.ª resposta (média, 30 dias)" value={durationLabel(metrics.avgFirstResponseSeconds)} />
        </MetricGrid>
      )}

      <div className="support-filters client-form">
        <Select label="Estado" value={status} onChange={(event) => setStatus(event.target.value as TicketStatus | '')}>
          <option value="">Todos</option>
          {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((value) => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
        </Select>
      </div>

      {error && !data ? <ErrorRetry message={error} onRetry={load} />
        : !data ? <SkeletonList rows={5} />
          : (
            <DataTable rows={data.items} rowKey={(row) => row.id} columns={columns}
              onRowClick={(row) => setOpenId(row.id)} activeKey={openId}
              gridTemplateColumns="64px 168px 96px minmax(140px, 1.2fr) minmax(180px, 1.6fr) 120px 110px minmax(110px, .8fr) 96px"
              empty={<EmptyState title={status ? 'Nenhum pedido neste estado' : 'Ainda sem pedidos'}
                description="Quando um cliente reportar uma avaria, registe-a em Novo pedido." />} />
          )}

      <NewTicketDialog open={creating} onClose={() => setCreating(false)}
        onCreated={(ticket) => { setCreating(false); load(); setOpenId(ticket.id); }} />
      {openId !== null && (
        <TicketDialog id={openId} assignees={assignees} canWrite={canWrite} onClose={() => setOpenId(null)} onChanged={load} />
      )}
    </section>
  );
}
