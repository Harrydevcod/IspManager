import { describe, expect, test } from 'vitest';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
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
    }, 'ISPM')).toBe('Ola Ana Lopes, a sua fatura FT-2026-001 de 06-2026, no valor de 4500 CVE, foi emitida. Vencimento: 10-06-2026. ISPM');
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
    }, 'ISPM')).toBe('Ola Ana Lopes, a fatura FT-2026-001 esta em atraso ha 7 dia(s). Valor: 4500 CVE. Regularize para evitar constrangimentos. ISPM');
  });

  test('renders suspension threshold', () => {
    const message = renderSmsTemplate(fallbackSmsSuspensionNoticeTemplate, {
      fullName: 'Ana Lopes',
      clientCode: 'CLT-001',
      invoiceNumber: 'FT-2026-001',
      suspensionDays: 15
    }, 'ISPM');

    expect(message).toBe('Ola Ana Lopes, a fatura FT-2026-001 continua em atraso. O servico podera ser suspenso apos 15 dia(s) de atraso. ISPM');
    expect(message).not.toMatch(/\{[^}]+\}/);
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
