import { describe, expect, test } from 'vitest';
import { validatePaymentDates } from './payment-dates';

const today = new Date('2026-07-02T10:00:00Z');
const opts = { today };

describe('validatePaymentDates', () => {
  test('accepts a coherent postpaid invoice', () => {
    expect(validatePaymentDates({
      dataReferencia: '2026-06',
      dataEmissao: '2026-07-01',
      dataVencimento: '2026-07-15',
      dataPagamento: '2026-07-10'
    }, opts)).toEqual({ errors: [], warnings: [] });
  });

  test('rule 1: reference after emission (message names dates in pt-PT)', () => {
    const { errors } = validatePaymentDates({ dataReferencia: '2026-08', dataEmissao: '2026-07-01' }, opts);
    expect(errors).toContain('A data de referência (08-2026) não pode ser posterior à data de emissão (01-07-2026).');
  });

  test('rule 2: payment before emission (only when payment present)', () => {
    const before = validatePaymentDates({ dataEmissao: '2026-07-01', dataPagamento: '2026-06-30' }, opts);
    expect(before.errors).toContain('A data de pagamento (30-06-2026) não pode ser anterior à data de emissão (01-07-2026).');
    // Nula → não valida.
    expect(validatePaymentDates({ dataEmissao: '2026-07-01', dataPagamento: null }, opts).errors).toEqual([]);
  });

  test('rule 3: due date before emission', () => {
    const { errors } = validatePaymentDates({ dataEmissao: '2026-07-10', dataVencimento: '2026-07-01' }, opts);
    expect(errors).toContain('A data de vencimento (01-07-2026) não pode ser anterior à data de emissão (10-07-2026).');
  });

  test('rule 4: due date before reference is flagged as an atypical warning', () => {
    const { warnings } = validatePaymentDates({
      dataReferencia: '2026-09',        // referência à frente do vencimento
      dataEmissao: '2026-07-01',
      dataVencimento: '2026-07-16'
    }, opts);
    expect(warnings).toContain('A data de vencimento (16-07-2026) é anterior ao período de referência (09-2026) — situação atípica, confirme.');
  });

  test('rule 5: emission in the future beyond tolerance', () => {
    expect(validatePaymentDates({ dataEmissao: '2026-07-03' }, opts).errors).toEqual([]); // dentro de 1 dia
    expect(validatePaymentDates({ dataEmissao: '2026-07-05' }, opts).errors)
      .toContain('A data de emissão (05-07-2026) não pode ser uma data futura.');
  });

  test('rule 6: reference beyond the forecast margin', () => {
    expect(validatePaymentDates({ dataReferencia: '2026-08' }, opts).errors).toEqual([]); // 2026-08-01 = hoje+30
    expect(validatePaymentDates({ dataReferencia: '2026-09' }, opts).errors)
      .toContain('A data de referência (09-2026) não pode exceder 30 dias no futuro.');
  });

  test('handles audiovisual reference (AV-AAAA-MM) as first of month', () => {
    expect(validatePaymentDates({ dataReferencia: 'AV-2026-06', dataEmissao: '2026-07-01' }, opts).errors).toEqual([]);
  });

  test('ignores malformed dates instead of throwing', () => {
    expect(() => validatePaymentDates({ dataEmissao: 'lixo', dataPagamento: '2026-13-40' }, opts)).not.toThrow();
    expect(validatePaymentDates({ dataEmissao: '2026-02-31' }, opts).errors).toEqual([]); // data impossível → ignorada
  });
});
