import type { EffectivePaymentStatus, PaymentRow } from '../types';
import { businessDay } from '../../shared/business-day';

type BadgeTone = 'success' | 'danger' | 'info' | 'neutral' | 'accent';

/**
 * Estado efetivo do pagamento: "em atraso" deriva da data de vencimento.
 * A coluna `status` só passa a 'overdue' quando alguém marca o pagamento à
 * mão — ninguém marca — por isso um pendente com a data passada é atraso,
 * diga o que disser a coluna. Mesma regra do overdueSqlPredicate no backend.
 *
 * "Parcial" também é derivado, de haver dinheiro recebido com a fatura ainda
 * aberta. A ordem importa: o atraso ganha ao parcial. Uma fatura meio paga que
 * passou o prazo continua a ser dívida vencida, e trocar o vermelho por um
 * âmbar simpático era esconder o caso que se quer ver primeiro.
 *
 * O "hoje" é o de Cabo Verde, o mesmo do backend (`SQL_BUSINESS_TODAY`): se divergissem,
 * cliente e servidor discordavam à meia-noite.
 */
export function effectivePaymentStatus(
  payment: Pick<PaymentRow, 'status' | 'dueDate'> & { receivedCve?: number },
  today = businessDay()
): EffectivePaymentStatus {
  if (payment.status === 'pending' && payment.dueDate < today) return 'overdue';
  if (payment.status === 'pending' && (payment.receivedCve || 0) > 0) return 'partial';
  return payment.status;
}

type ClientOrServiceStatus = 'active' | 'suspended' | 'cancelled';

export function statusTone(status: ClientOrServiceStatus): BadgeTone {
  switch (status) {
    case 'active': return 'success';
    case 'suspended': return 'info';
    case 'cancelled': return 'neutral';
  }
}

export function statusLabel(status: ClientOrServiceStatus): string {
  switch (status) {
    case 'active': return 'Ativo';
    case 'suspended': return 'Suspenso';
    case 'cancelled': return 'Cancelado';
  }
}

/**
 * Estado do serviço como o operador o lê: uma pausa a pedido do cliente não é
 * um corte, e diz quando acaba.
 */
export function serviceStatusLabel(service: {
  status: ClientOrServiceStatus;
  suspensionSource?: string | null;
  pauseUntil?: string | null;
}): string {
  if (service.status !== 'suspended' || service.suspensionSource !== 'client_request') return statusLabel(service.status);
  if (!service.pauseUntil) return 'Em pausa';
  const [, month, day] = service.pauseUntil.split('-');
  // Curto de propósito: a 1225 px a coluna Estado da ficha parte "regressa a" em duas linhas.
  return `Em pausa até ${day}/${month}`;
}

export function planActiveTone(active: number): BadgeTone {
  return active ? 'success' : 'neutral';
}

export function planActiveLabel(active: number): string {
  return active ? 'Ativo' : 'Inativo';
}

export function stockLevelTone(stockTotal: number): BadgeTone {
  if (stockTotal <= 0) return 'danger';
  if (stockTotal <= 3) return 'info';
  return 'success';
}
