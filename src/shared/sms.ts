import { renderMessageTemplate } from './message-template';

export type SmsEventType = 'invoice_issued' | 'receipt_confirmed' | 'payment_overdue' | 'suspension_notice';

// GSM-7 de propósito: sem á/ã/ç/õ cada aviso cabe em 1 SMS (160 caracteres);
// com eles passa a UCS-2 (70 por parte). Por isso "Caso tenha pago" e não "Se já pagou".
export const fallbackSmsInvoiceIssuedTemplate = 'Caro cliente, a sua fatura {fatura} de {mes}, no valor de {valor}, foi emitida. Vencimento: {vencimento}. Obrigado, {empresa}';
export const fallbackSmsReceiptConfirmedTemplate = 'Caro cliente, confirmamos o pagamento de {valor} referente a {mes}. Recibo {recibo}. Muito obrigado, {empresa}';
export const fallbackSmsPaymentOverdueTemplate = 'Caro cliente, a fatura {fatura} de {mes} ({valor}) venceu a {vencimento}. Pedimos que regularize. Caso tenha pago, ignore. {empresa}';
export const fallbackSmsSuspensionNoticeTemplate = 'Caro cliente, a fatura {fatura} ({valor}) continua por pagar. A internet pode ser suspensa a {data_suspensao}. Caso tenha pago, ignore. {empresa}';

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
  /**
   * Link de pagamento online. Fora dos modelos por omissão: a página do Stripe
   * tem um URL longo, que num SMS custa vários segmentos. Quem quiser, põe `{link}`.
   */
  paymentLink?: string | null;
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
