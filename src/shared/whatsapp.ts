import { formatPtDate, formatPtMonth } from './date';

export const fallbackWhatsappTemplate = 'Ola {nome}, somos da {empresa}. Entramos em contacto sobre o seu servico de internet.';
export const fallbackWhatsappTestTemplate = 'Teste UltraMsg - {empresa}. Ola {nome}, esta mensagem confirma que a integracao WhatsApp esta ativa.';
export const fallbackWhatsappInvoiceReadyTemplate = 'Ola {nome}, a sua fatura {fatura} de {mes} no valor de {valor} CVE ja esta pronta. Vencimento: {vencimento}. {empresa}';
export const fallbackWhatsappReceiptTemplate = 'Ola {nome}, confirmamos o recebimento de {valor} CVE referente a {mes}. O seu recibo {recibo} foi emitido. Obrigado, {empresa}.';
export const fallbackWhatsappOverdueTemplate = 'Ola {nome}, a sua fatura {fatura} de {mes}, no valor de {valor} CVE, esta em atraso desde {vencimento}. Por favor regularize para evitar constrangimentos. {empresa}';
export const fallbackWhatsappSuspensionTemplate = 'Ola {nome}, a sua fatura {fatura} continua em atraso ha {dias_atraso} dia(s). O servico podera ser suspenso apos {dias_suspensao} dia(s) de atraso. Regularize para evitar corte. {empresa}';

export type WhatsappTemplateData = {
  fullName: string;
  clientCode: string;
  phone?: string | null;
  amountCve?: number;
  dueDate?: string;
  referenceMonth?: string;
  invoiceNumber?: string | null;
  receiptNumber?: string | null;
  daysOverdue?: number;
  suspensionDays?: number;
};

export function renderWhatsappTemplate(template: string, data: WhatsappTemplateData, companyName: string) {
  return template
    .replace(/\{nome\}/gi, data.fullName || '-')
    .replace(/\{cliente\}/gi, data.fullName || '-')
    .replace(/\{codigo\}/gi, data.clientCode || '-')
    .replace(/\{telefone\}/gi, data.phone || '')
    .replace(/\{empresa\}/gi, companyName || 'ISPM')
    .replace(/\{valor\}/gi, data.amountCve == null ? '-' : String(data.amountCve))
    .replace(/\{vencimento\}/gi, formatPtDate(data.dueDate))
    .replace(/\{mes\}/gi, formatPtMonth(data.referenceMonth))
    .replace(/\{fatura\}/gi, data.invoiceNumber || '-')
    .replace(/\{recibo\}/gi, data.receiptNumber || '-')
    .replace(/\{dias_atraso\}/gi, data.daysOverdue == null ? '-' : String(data.daysOverdue))
    .replace(/\{dias_suspensao\}/gi, data.suspensionDays == null ? '-' : String(data.suspensionDays));
}
