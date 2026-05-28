import { describe, expect, test } from 'vitest';
import { renderWhatsappTemplate } from './whatsapp';

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

    expect(message).toBe('Maria Lopes/Maria Lopes CLT-010 2389910000 ISP CV 2500 2026-05-10 2026-05 FT-2026-00010 RC-2026-00010 15/20');
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
