import { describe, expect, it } from 'vitest';
import { effectivePaymentStatus } from './status';

const hoje = '2026-08-14';

describe('effectivePaymentStatus', () => {
  it('trata o pendente com a data passada como atraso', () => {
    expect(effectivePaymentStatus({ status: 'pending', dueDate: '2026-07-30' }, hoje)).toBe('overdue');
  });

  it('deixa pendente o que vence hoje', () => {
    expect(effectivePaymentStatus({ status: 'pending', dueDate: hoje }, hoje)).toBe('pending');
  });

  it('deixa pendente o que ainda nao venceu', () => {
    expect(effectivePaymentStatus({ status: 'pending', dueDate: '2026-08-29' }, hoje)).toBe('pending');
  });

  it('nao mexe no que ja foi pago nem no anulado, por muito antiga que seja a data', () => {
    expect(effectivePaymentStatus({ status: 'paid', dueDate: '2026-01-01' }, hoje)).toBe('paid');
    expect(effectivePaymentStatus({ status: 'cancelled', dueDate: '2026-01-01' }, hoje)).toBe('cancelled');
  });

  it('mantem o atraso marcado a mao mesmo com a data no futuro', () => {
    expect(effectivePaymentStatus({ status: 'overdue', dueDate: '2026-12-31' }, hoje)).toBe('overdue');
  });
});
