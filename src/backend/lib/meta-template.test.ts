import { describe, expect, test } from 'vitest';
import { prepareMetaTemplate } from './meta-template';

describe('prepareMetaTemplate', () => {
  const data = { fullName: 'Ana', clientCode: 'C1', amountCve: 2000 };
  test('maps fields in text order, including repeated fields', () => {
    expect(prepareMetaTemplate({ name: 'cobranca', language: 'pt_PT', body: 'Olá {{1}}, {{2}} e {{3}}' },
      'Olá {nome}, {valor} e {nome}', data, 'ISP')).toEqual({
      ok: true, template: { name: 'cobranca', language: 'pt_PT', params: ['Ana', '2.000$00', 'Ana'] }
    });
  });
  test('rejects a parameter count mismatch before sending', () => {
    expect(prepareMetaTemplate({ name: 'aviso', language: 'pt_PT', body: 'Olá {{1}}' }, '{nome} {valor}', data, 'ISP')).toMatchObject({ ok: false });
  });
  test('rejects a different approved message even if the parameter counts match', () => {
    expect(prepareMetaTemplate({ name: 'aviso', language: 'pt_PT', body: 'Pagamento recebido, {{1}}' }, 'Pagamento em atraso, {nome}', data, 'ISP')).toMatchObject({ ok: false });
  });
  test('rejects unknown and empty values before sending', () => {
    expect(prepareMetaTemplate({ name: 'aviso', language: 'pt_PT', body: '{{1}}' }, '{inexistente}', data, 'ISP')).toMatchObject({ ok: false });
    expect(prepareMetaTemplate({ name: 'aviso', language: 'pt_PT', body: '{{1}}' }, '{link}', data, 'ISP')).toMatchObject({ ok: false });
  });
  test('rejects nonsequential Meta parameters', () => {
    expect(prepareMetaTemplate({ name: 'aviso', language: 'pt_PT', body: '{{2}}' }, '{nome}', data, 'ISP')).toMatchObject({ ok: false });
    expect(prepareMetaTemplate({ name: 'aviso', language: 'pt_PT', body: '{{cliente}}' }, 'Sem campos', data, 'ISP')).toMatchObject({ ok: false });
  });
});
