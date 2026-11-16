import { expect, test } from 'vitest';
import * as sms from './sms';

// Alfabeto GSM-7 básico (3GPP 23.038) e a extensão de uma posição: fora dele o SMS passa a 70 por parte.
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

const data = {
  fullName: 'Ana Lopes', clientCode: 'C001', phone: '+2389911001', amountCve: 2750, dueDate: '2026-11-10',
  referenceMonth: '2026-10', invoiceNumber: 'FT 2026/1301', receiptNumber: 'RC 2026/1301', daysOverdue: 12,
  suspensionDays: 16, suspensionDate: '2026-12-02', services: 'Internet Standard', periodLabel: 'setembro de 2026'
};

const templates = Object.entries(sms).filter(([name, value]) => name.startsWith('fallbackSms') && typeof value === 'string') as Array<[string, string]>;

test.each(templates)('%s cabe num SMS GSM-7 com dados realistas', (_name, template) => {
  const body = sms.renderSmsTemplate(template, data, 'NovaTech Telecom');
  expect(body).toMatch(GSM7);
  expect(body.length).toBeLessThanOrEqual(160);
  expect(body).not.toMatch(/\{[a-z_]+\}/);
});

test('o serviço e o mês do SMS perdem os acentos que não são GSM-7', () => {
  expect(sms.renderSmsTemplate('{servico} · {mes}', { ...data, services: 'instalação', periodLabel: 'março de 2026' }, 'X')).toBe('instalacao · marco de 2026');
});
