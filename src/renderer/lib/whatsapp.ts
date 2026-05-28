import type { WhatsappMessageData } from '../types';
export {
  fallbackWhatsappInvoiceReadyTemplate,
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReceiptTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  fallbackWhatsappTestTemplate
} from '../../shared/whatsapp';
import { renderWhatsappTemplate } from '../../shared/whatsapp';
import { authFetch } from './auth';

export function normalizeWhatsappPhone(phone: string | null) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) {
    return '';
  }
  if (digits.startsWith('238')) {
    return digits;
  }
  if (digits.length === 7) {
    return `238${digits}`;
  }
  return digits;
}

type WhatsappTemplateContext = {
  amountCve?: number;
  dueDate?: string;
  referenceMonth?: string;
  invoiceNumber?: string | null;
  receiptNumber?: string | null;
  daysOverdue?: number;
  suspensionDays?: number;
};

export function renderWhatsappMessage(template: string, client: WhatsappMessageData, companyName: string, context: WhatsappTemplateContext = {}) {
  return renderWhatsappTemplate(template, { ...context, ...client }, companyName);
}

export async function sendWhatsappViaUltraMsg(phone: string | null, body: string) {
  const normalizedPhone = normalizeWhatsappPhone(phone);
  if (!normalizedPhone) {
    throw new Error('Telefone WhatsApp invalido');
  }

  const response = await authFetch('http://127.0.0.1:3001/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: normalizedPhone,
      body
    })
  });

  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: 'Nao foi possivel enviar WhatsApp' })) as { error?: string };
    throw new Error(result.error || 'Nao foi possivel enviar WhatsApp');
  }
}
