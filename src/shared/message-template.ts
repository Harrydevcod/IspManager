import { formatPtDate, parseDate } from './date';
import { formatEscudos } from './money';
import { expandPaymentLink } from './payment-link';

/** Dados de uma mensagem ao cliente, comuns ao WhatsApp e ao SMS. */
export type MessageTemplateData = {
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
  /** Link de pagamento online da fatura; vazio = `{link}` desaparece. */
  paymentLink?: string | null;
};

/** `2026-11` → `novembro de 2026`. As mensagens levam o mês por extenso. */
export function formatPtMonthLong(value: string | null | undefined): string {
  const [year, month] = (value || '').slice(0, 7).split('-').map(Number);
  if (!year || !month || month > 12) return '-';
  const name = new Intl.DateTimeFormat('pt-PT', { month: 'long' }).format(new Date(year, month - 1, 1));
  return `${name} de ${year}`;
}

function days(count: number | undefined): string {
  if (count == null) return '-';
  return count === 1 ? '1 dia' : `${count} dias`;
}

/** Vencimento + dias de tolerância = o dia em que o serviço pode ser suspenso. */
function suspensionDate(dueDate: string | null | undefined, suspensionDays: number | undefined): string {
  const due = parseDate(dueDate);
  if (!due || suspensionDays == null) return '-';
  due.setDate(due.getDate() + suspensionDays);
  return formatPtDate(`${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`);
}

/**
 * Substitui as variáveis `{nome}`, `{valor}`, … de um modelo. Uma variável
 * desconhecida fica como está, para o erro se ver na pré-visualização.
 * `gsm7`: o SMS só leva caracteres do alfabeto GSM-7 (1 SMS = 160 caracteres);
 * o "ç" do mês ("março") passaria a mensagem para UCS-2, com 70 por parte.
 */
export function renderMessageTemplate(template: string, data: MessageTemplateData, companyName: string, options: { gsm7?: boolean } = {}): string {
  const month = formatPtMonthLong(data.referenceMonth);
  const values: Record<string, string> = {
    nome: data.fullName || '-',
    cliente: data.fullName || '-',
    codigo: data.clientCode || '-',
    telefone: data.phone || '',
    empresa: companyName || 'ISPM',
    valor: data.amountCve == null ? '-' : formatEscudos(data.amountCve),
    vencimento: formatPtDate(data.dueDate),
    mes: options.gsm7 ? month.replace(/ç/g, 'c') : month,
    fatura: data.invoiceNumber || '-',
    recibo: data.receiptNumber || '-',
    dias_atraso: days(data.daysOverdue),
    dias_suspensao: days(data.suspensionDays),
    data_suspensao: suspensionDate(data.dueDate, data.suspensionDays)
  };
  return expandPaymentLink(template, data.paymentLink).replace(/\{([a-z_]+)\}/gi, (token, key: string) => values[key.toLowerCase()] ?? token);
}
