import { renderMessageTemplate } from './message-template';

export type SmsEventType = 'invoice_issued' | 'receipt_confirmed' | 'payment_reminder' | 'payment_overdue' | 'payment_warning' | 'suspension_notice';

// GSM-7 de propósito: sem á/ã/ç/õ cada aviso cabe em 1 SMS (160 caracteres);
// com eles passa a UCS-2 (70 por parte). Por isso "Caso tenha pago" e não "Se já pagou".
export const fallbackSmsInvoiceIssuedTemplate = 'Caro cliente, a fatura {fatura} de {mes} ({servico}), no valor de {valor}, foi emitida. Vence a {vencimento}. Obrigado, {empresa}';
export const fallbackSmsReceiptConfirmedTemplate = 'Caro cliente, confirmamos o pagamento de {valor} de {servico}, {mes}. Recibo {recibo}. Muito obrigado, {empresa}';
export const fallbackSmsPaymentOverdueTemplate = 'Caro cliente, a fatura {fatura} de {mes} ({servico}, {valor}) venceu a {vencimento}. Caso tenha pago, ignore. {empresa}';
export const fallbackSmsSuspensionNoticeTemplate = 'Caro cliente, a fatura {fatura} ({servico}, {mes}, {valor}) esta por pagar. A internet pode ser suspensa a {data_suspensao}. {empresa}';
export const fallbackSmsPaymentReminderTemplate = 'Caro cliente, a fatura {fatura} de {mes} ({servico}, {valor}) vence a {vencimento}. Caso tenha pago, ignore. {empresa}';
export const fallbackSmsPaymentWarningTemplate = 'Caro cliente, a fatura {fatura} de {mes} ({servico}, {valor}) continua por pagar ha {dias_atraso}. Pedimos que regularize. {empresa}';
export const fallbackSmsGeneralTemplate = 'Caro cliente, fala a {empresa}. Entramos em contacto a proposito do seu servico de internet.';
export const fallbackSmsMaintenanceTemplate = 'Caro cliente, a {data}, das {inicio} as {fim}, faremos {motivo} na sua zona; a internet pode falhar. Desculpe. {empresa}';
export const fallbackSmsOutageTemplate = 'Caro cliente, detetamos uma avaria na rede que afeta a sua internet. A equipa esta a resolver e avisamos quando voltar. Pedimos desculpa. {empresa}';
export const fallbackSmsRestoredTemplate = 'Caro cliente, a avaria na rede foi resolvida e a sua internet esta reposta. Obrigado pela paciencia. {empresa}';

export type SmsTemplateData = {
  fullName: string;
  clientCode: string | null;
  phone?: string | null;
  amountCve?: number;
  dueDate?: string | null;
  referenceMonth?: string | null;
  invoiceNumber?: string | null;
  receiptNumber?: string | null;
  daysOverdue?: number;
  suspensionDays?: number;
  suspensionDate?: string | null;
  /**
   * Link de pagamento online. Fora dos modelos por omissão: a página do Stripe
   * tem um URL longo, que num SMS custa vários segmentos. Quem quiser, põe `{link}`.
   */
  paymentLink?: string | null;
  /** O que a fatura ou o recibo cobra: `{servico}`. */
  services?: string | null;
  /** O período já descrito (por extenso), para `{mes}`. */
  periodLabel?: string | null;
};

export function normalizeSmsPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 7) return `+238${digits}`;
  if (digits.startsWith('238') && digits.length === 10) return `+${digits}`;
  if (digits.startsWith('00238') && digits.length === 12) return `+${digits.slice(2)}`;
  return '';
}

export function renderSmsTemplate(template: string, data: SmsTemplateData, companyName: string): string {
  return renderMessageTemplate(template, data, companyName, { gsm7: true });
}
