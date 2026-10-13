import { describe, expect, test } from 'vitest';
import { expandPaymentLink } from './payment-link';
import { renderSmsTemplate } from './sms';
import { fallbackWhatsappOverdueTemplate, renderWhatsappTemplate } from './whatsapp';

const URL = 'https://invoice.stripe.com/i/abc';
const client = { fullName: 'Ana', clientCode: 'C001' };

describe('variável {link}', () => {
  test('com link, expande para a frase inteira', () => {
    expect(expandPaymentLink('Regularize. {link}', URL)).toBe(`Regularize. Pague online: ${URL}`);
  });

  test('sem link não fica frase nem espaço pendurado', () => {
    expect(expandPaymentLink('Regularize. {link}', null)).toBe('Regularize.');
    expect(expandPaymentLink('Regularize. {LINK} Obrigado.', '')).toBe('Regularize. Obrigado.');
  });

  test('o modelo de atraso do WhatsApp leva o link só quando a fatura o tem', () => {
    const withLink = renderWhatsappTemplate(fallbackWhatsappOverdueTemplate, { ...client, paymentLink: URL }, 'ISPM');
    const without = renderWhatsappTemplate(fallbackWhatsappOverdueTemplate, client, 'ISPM');

    expect(withLink.endsWith(`ISPM Pague online: ${URL}`)).toBe(true);
    expect(without.endsWith('ISPM')).toBe(true);
    expect(without).not.toContain('{link}');
  });

  test('no SMS a variável funciona quando o modelo a pede', () => {
    expect(renderSmsTemplate('Ola {nome}. {link}', { ...client, paymentLink: URL }, 'ISPM')).toBe(`Ola Ana. Pague online: ${URL}`);
    expect(renderSmsTemplate('Ola {nome}. {link}', client, 'ISPM')).toBe('Ola Ana.');
  });
});
