import { renderMessageTemplate } from './message-template';

// Tom: cordial e igual para todos ("Caro cliente"), sem ameaças, com a saída
// para quem já pagou. A migração 0093 leva estes textos a quem nunca os editou.
export const fallbackWhatsappTemplate = 'Caro cliente, fala a {empresa}. Entramos em contacto a propósito do seu serviço de internet.';
export const fallbackWhatsappTestTemplate = 'Caro cliente, esta é uma mensagem de teste da {empresa}. A ligação ao WhatsApp está a funcionar.';
export const fallbackWhatsappInvoiceReadyTemplate = 'Caro cliente,\n\nA sua fatura {fatura} de {mes} já está disponível.\nValor: {valor}\nVencimento: {vencimento}\n{link}\n\nObrigado pela preferência.\n{empresa}';
export const fallbackWhatsappReceiptTemplate = 'Caro cliente,\n\nConfirmamos a receção do seu pagamento de {valor}, referente a {mes}. O recibo {recibo} já foi emitido.\n\nObrigado pela confiança.\n{empresa}';
export const fallbackWhatsappReminderTemplate = 'Caro cliente,\n\nLembramos que a sua fatura {fatura} de {mes}, no valor de {valor}, vence a {vencimento}.\n{link}\n\nSe já efetuou o pagamento, agradecemos e pode ignorar esta mensagem.\n{empresa}';
export const fallbackWhatsappOverdueTemplate = 'Caro cliente,\n\nAinda não registámos o pagamento da fatura {fatura} de {mes} ({valor}), com vencimento a {vencimento}. Pedimos a gentileza de regularizar assim que possível.\n{link}\n\nSe já pagou, por favor ignore esta mensagem. Para qualquer dúvida, estamos ao dispor.\n{empresa}';
export const fallbackWhatsappWarningTemplate = 'Caro cliente,\n\nA fatura {fatura} de {mes} ({valor}) continua por regularizar há {dias_atraso}. Para manter o seu serviço sem interrupções, pedimos que efetue o pagamento com a maior brevidade.\n{link}\n\nSe precisar de combinar outra forma de pagamento, fale connosco.\n{empresa}';
export const fallbackWhatsappSuspensionTemplate = 'Caro cliente,\n\nA fatura {fatura} ({valor}) está em atraso há {dias_atraso}. Sem regularização, o serviço de internet será suspenso a {data_suspensao}.\n{link}\n\nSe já pagou, ignore esta mensagem. Estamos disponíveis para ajudar.\n{empresa}';

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
  suspensionDate?: string | null;
  /** Link de pagamento online da fatura; vazio = `{link}` desaparece. */
  paymentLink?: string | null;
};

export function renderWhatsappTemplate(template: string, data: WhatsappTemplateData, companyName: string) {
  return renderMessageTemplate(template, data, companyName);
}
