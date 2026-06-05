import { formatPtDate, formatPtMonth } from './date';

export type SmsEventType = 'invoice_issued' | 'receipt_confirmed' | 'payment_overdue' | 'suspension_notice';

export const fallbackSmsInvoiceIssuedTemplate = 'Ola {nome}, a sua fatura {fatura} de {mes}, no valor de {valor} CVE, foi emitida. Vencimento: {vencimento}. {empresa}';
export const fallbackSmsReceiptConfirmedTemplate = 'Ola {nome}, confirmamos o recebimento de {valor} CVE referente a {mes}. Recibo {recibo}. Obrigado, {empresa}.';
export const fallbackSmsPaymentOverdueTemplate = 'Ola {nome}, a fatura {fatura} esta em atraso ha {dias_atraso} dia(s). Valor: {valor} CVE. Regularize para evitar constrangimentos. {empresa}';
export const fallbackSmsSuspensionNoticeTemplate = 'Ola {nome}, a fatura {fatura} continua em atraso. O servico podera ser suspenso apos {dias_suspensao} dia(s) de atraso. {empresa}';

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
};

export function normalizeSmsPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 7) return `+238${digits}`;
  if (digits.startsWith('238') && digits.length === 10) return `+${digits}`;
  if (digits.startsWith('00238') && digits.length === 12) return `+${digits.slice(2)}`;
  return '';
}

export function renderSmsTemplate(template: string, data: SmsTemplateData, companyName: string): string {
  const values: Record<string, string> = {
    nome: data.fullName || '-',
    cliente: data.fullName || '-',
    codigo: data.clientCode || '-',
    telefone: data.phone || '',
    empresa: companyName || 'ISPM',
    valor: data.amountCve == null ? '-' : String(data.amountCve),
    vencimento: formatPtDate(data.dueDate),
    mes: formatPtMonth(data.referenceMonth),
    fatura: data.invoiceNumber || '-',
    recibo: data.receiptNumber || '-',
    dias_atraso: data.daysOverdue == null ? '-' : String(data.daysOverdue),
    dias_suspensao: data.suspensionDays == null ? '-' : String(data.suspensionDays)
  };

  return template.replace(/\{([a-z_]+)\}/gi, (token, key: string) => values[key.toLowerCase()] ?? token);
}
