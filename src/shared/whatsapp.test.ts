import { describe, expect, test } from 'vitest';
import {
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReminderTemplate,
  fallbackWhatsappSuspensionTemplate,
  renderWhatsappTemplate
} from './whatsapp';

describe('renderWhatsappTemplate', () => {
  test('renders customer, document, amount and suspension placeholders case-insensitively', () => {
    const message = renderWhatsappTemplate(
      '{NOME}/{cliente} {codigo} {telefone} {empresa} {valor} {vencimento} {mes} {fatura} {recibo} {dias_atraso}/{dias_suspensao}',
      {
        fullName: 'Maria Lopes',
        clientCode: 'CLT-010',
        phone: '2389910000',
        amountCve: 2500,
        dueDate: '2026-05-10',
        referenceMonth: '2026-05',
        invoiceNumber: 'FT-2026-00010',
        receiptNumber: 'RC-2026-00010',
        daysOverdue: 15,
        suspensionDays: 20
      },
      'ISP CV'
    );

    expect(message).toBe('Maria Lopes/Maria Lopes CLT-010 2389910000 ISP CV 2.500$00 10-05-2026 maio de 2026 FT-2026-00010 RC-2026-00010 15 dias/20 dias');
  });

  test('data de suspensão = vencimento + dias de tolerância; 1 dia no singular', () => {
    const message = renderWhatsappTemplate('{data_suspensao} {dias_atraso}', {
      fullName: 'Maria', clientCode: 'C', dueDate: '2026-12-20', daysOverdue: 1, suspensionDays: 15
    }, 'ISP');
    expect(message).toBe('04-01-2027 1 dia');
  });

  test('os modelos por omissão saúdam todos por igual e dão saída a quem já pagou', () => {
    const data = { fullName: 'Maria Lopes', clientCode: 'C', amountCve: 2500, dueDate: '2026-11-10', referenceMonth: '2026-11', invoiceNumber: 'FT-1', daysOverdue: 20, suspensionDays: 15 };
    for (const template of [fallbackWhatsappReminderTemplate, fallbackWhatsappOverdueTemplate, fallbackWhatsappSuspensionTemplate]) {
      const message = renderWhatsappTemplate(template, data, 'ISP');
      expect(message.startsWith('Caro cliente,')).toBe(true);
      expect(message).not.toContain('Maria');
      expect(message).toMatch(/já (pagou|efetuou o pagamento)/);
      expect(message).not.toMatch(/\{[^}]+\}|CVE|\n\n\n/);
    }
    expect(renderWhatsappTemplate(fallbackWhatsappSuspensionTemplate, data, 'ISP')).toContain('suspenso a 25-11-2026');
  });

  test('uses stable fallbacks for optional operational fields', () => {
    const message = renderWhatsappTemplate(
      '{nome} {codigo} {empresa} {valor} {vencimento} {mes} {fatura} {recibo} {dias_atraso} {dias_suspensao}',
      {
        fullName: '',
        clientCode: '',
        phone: null
      },
      ''
    );

    expect(message).toBe('- - ISPM - - - - - - -');
  });
});
