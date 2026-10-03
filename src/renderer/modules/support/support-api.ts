import { authFetch } from '../../lib/auth';

export const TICKETS_API = 'http://127.0.0.1:3001/api/tickets';

export type TicketStatus = 'aberto' | 'em_curso' | 'aguarda_cliente' | 'resolvido' | 'fechado';
export type TicketPriority = 'baixa' | 'media' | 'alta';
export type TicketChannel = 'telefone' | 'whatsapp' | 'presencial' | 'email' | 'outro';
export type TicketCategory = 'sem_ligacao' | 'lento' | 'intermitente' | 'equipamento' | 'faturacao' | 'outro';

export const STATUS_LABEL: Record<TicketStatus, string> = {
  aberto: 'Aberto', em_curso: 'Em curso', aguarda_cliente: 'A aguardar o cliente', resolvido: 'Resolvido', fechado: 'Fechado'
};
export const STATUS_TONE: Record<TicketStatus, 'danger' | 'info' | 'warn' | 'success' | 'neutral'> = {
  aberto: 'danger', em_curso: 'info', aguarda_cliente: 'warn', resolvido: 'success', fechado: 'neutral'
};
export const PRIORITY_LABEL: Record<TicketPriority, string> = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
export const CHANNEL_LABEL: Record<TicketChannel, string> = {
  telefone: 'Telefone', whatsapp: 'WhatsApp', presencial: 'Presencial', email: 'Email', outro: 'Outro'
};
export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  sem_ligacao: 'Sem ligação', lento: 'Lento', intermitente: 'Intermitente', equipamento: 'Equipamento', faturacao: 'Faturação', outro: 'Outro'
};

export type Ticket = {
  id: number;
  clientId: number;
  clientCode: string;
  clientName: string;
  serviceId: number | null;
  pppoeUsername: string | null;
  planName: string | null;
  subject: string;
  channel: TicketChannel;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  openedByName: string | null;
  assignedToId: number | null;
  assignedToName: string | null;
  openedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
};

export type TicketEntry = { id: number; kind: 'nota' | 'mudanca_estado' | 'os_criada'; body: string; createdAt: string; authorName: string | null };
export type TicketWorkOrder = { id: number; title: string; status: string; assignedTo: string | null; scheduledAt: string | null };
export type TicketDetail = Ticket & { entries: TicketEntry[]; workOrders: TicketWorkOrder[] };
export type TicketMetrics = { open: number; waiting: number; resolvedThisMonth: number; avgFirstResponseSeconds: number | null };
export type TicketList = { items: Ticket[]; metrics: TicketMetrics };
export type Assignee = { id: number; fullName: string; role: string };

/** Lê ou escreve na API e devolve o corpo; um erro traz a mensagem do servidor. */
export async function ticketsRequest<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await authFetch(`${TICKETS_API}${path}`, init && {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(init.body ?? {})
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Não foi possível concluir o pedido.');
  return body;
}

/** "há 3 h", "há 2 d": o tempo desde a abertura, para a lista. */
export function sinceLabel(at: string, now = Date.now()): string {
  const opened = Date.parse(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`);
  const minutes = Math.max(0, Math.round((now - opened) / 60_000));
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} d`;
}

export function durationLabel(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1).replace('.', ',')} h` : `${Math.round(hours / 24)} d`;
}
