import { describe, expect, test } from 'vitest';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate,
  normalizeSmsPhone,
  renderSmsTemplate
} from './sms';

describe('normalizeSmsPhone', () => {
  test('normalizes Cabo Verde local numbers to +238', () => {
    expect(normalizeSmsPhone('991 22 33')).toBe('+2389912233');
  });

  test('keeps numbers that already include the country code', () => {
    expect(normalizeSmsPhone('+238 991 22 33')).toBe('+2389912233');
  });

  test('normalizes international 00 prefix for Cabo Verde', () => {
    expect(normalizeSmsPhone('00 238 991 22 33')).toBe('+2389912233');
  });

  test('rejects 00 prefix without Cabo Verde country code', () => {
    expect(normalizeSmsPhone('00 991 22 33')).toBe('');
  });

  test('rejects empty phone values', () => {
    expect(normalizeSmsPhone('')).toBe('');
  });

  test('rejects partial and unsupported phone values', () => {
    expect(normalizeSmsPhone('238')).toBe('');
    expect(normalizeSmsPhone('238123')).toBe('');
    expect(normalizeSmsPhone('238991223399')).toBe('');
    expect(normalizeSmsPhone('+351 912 345 678')).toBe('');
  });
});

describe('renderSmsTemplate', () => {
  test('renders invoice issued messages with stable placeholders', () => {
    expect(renderSmsTemplate(fallbackSmsInvoiceIssuedTemplate, {
      fullName: 'Ana Lopes',
      clientCode: 'CLT-001',
      amountCve: 4500,
      dueDate: '2026-06-10',
      referenceMonth: '2026-06',
      invoiceNumber: 'FT-2026-001'
    }, 'ISPM')).toBe('Caro cliente, a sua fatura FT-2026-001 de junho de 2026, no valor de 4.500$00, foi emitida. Vencimento: 10-06-2026. Obrigado, ISPM');
  });

  test('renders overdue days', () => {
    expect(renderSmsTemplate(fallbackSmsPaymentOverdueTemplate, {
      fullName: 'Ana Lopes',
      clientCode: 'CLT-001',
      amountCve: 4500,
      dueDate: '2026-06-10',
      referenceMonth: '2026-06',
      invoiceNumber: 'FT-2026-001',
      daysOverdue: 7,
      suspensionDays: 15
    }, 'ISPM')).toBe('Caro cliente, a fatura FT-2026-001 de junho de 2026 (4.500$00) venceu a 10-06-2026. Pedimos que regularize. Caso tenha pago, ignore. ISPM');
  });

  test('renders suspension threshold', () => {
    const message = renderSmsTemplate(fallbackSmsSuspensionNoticeTemplate, {
      fullName: 'Ana Lopes',
      clientCode: 'CLT-001',
      invoiceNumber: 'FT-2026-001',
      amountCve: 4500,
      dueDate: '2026-06-10',
      suspensionDays: 15
    }, 'ISPM');

    expect(message).toBe('Caro cliente, a fatura FT-2026-001 (4.500$00) continua por pagar. A internet pode ser suspensa a 25-06-2026. Caso tenha pago, ignore. ISPM');
    expect(message).not.toMatch(/\{[^}]+\}/);
  });

  // GSM-7 básico (3GPP TS 23.038), sem a tabela de extensão.
  const GSM7 = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');

  test('cada modelo por omissão cabe num só SMS GSM-7, no mês mais longo e com nomes longos', () => {
    const data = {
      fullName: 'Maria da Graça Lopes Fortes',
      clientCode: 'CLT-00123',
      amountCve: 12500,
      dueDate: '2026-09-10',
      referenceMonth: '2026-09',
      invoiceNumber: 'FT-2026-00123',
      receiptNumber: 'RC-2026-00123',
      daysOverdue: 30,
      suspensionDays: 15
    };
    for (const template of [fallbackSmsInvoiceIssuedTemplate, fallbackSmsReceiptConfirmedTemplate, fallbackSmsPaymentOverdueTemplate, fallbackSmsSuspensionNoticeTemplate]) {
      const message = renderSmsTemplate(template, data, 'Novatech CV');
      expect([...message].filter((char) => !GSM7.has(char))).toEqual([]);
      expect(message.length).toBeLessThanOrEqual(160);
    }
  });

  test('o mês sai por extenso e, no SMS, sem o ç de março', () => {
    expect(renderSmsTemplate('{mes}', { fullName: 'A', clientCode: null, referenceMonth: '2026-03' }, 'ISPM')).toBe('marco de 2026');
  });

  test('does not re-process placeholders introduced by data values', () => {
    expect(renderSmsTemplate('Ola {nome}. Empresa {empresa}.', {
      fullName: '{empresa}',
      clientCode: 'CLT-001'
    }, 'ISPM')).toBe('Ola {empresa}. Empresa ISPM.');
  });

  test('keeps unknown placeholders visible', () => {
    expect(renderSmsTemplate('Ola {nome}, {desconhecido}.', {
      fullName: 'Ana',
      clientCode: 'CLT-001'
    }, 'ISPM')).toBe('Ola Ana, {desconhecido}.');
  });
});
