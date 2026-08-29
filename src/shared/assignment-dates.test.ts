import { describe, expect, test } from 'vitest';
import { todayIso, validateAssignmentDates } from './assignment-dates';

const today = new Date('2026-08-28T10:00:00Z');
const check = (dates: Parameters<typeof validateAssignmentDates>[0]) =>
  validateAssignmentDates(dates, { today });

describe('datas de atribuicao', () => {
  test('uma instalacao retroativa e o caso normal, nao um aviso', () => {
    expect(check({ startDate: '2026-03-15', activationDate: '2026-01-10' }))
      .toEqual({ errors: [], warnings: [] });
  });

  test('recusa instalar no futuro, com tolerancia de um dia para o fuso', () => {
    expect(check({ startDate: '2026-08-29' }).errors).toEqual([]);
    expect(check({ startDate: '2026-08-30' }).errors)
      .toEqual(['Data de instalação 30-08-2026 está no futuro.']);
  });

  test('recusa sair antes de ter entrado', () => {
    expect(check({ startDate: '2026-05-10', endDate: '2026-05-09' }).errors)
      .toEqual(['Data de saída 09-05-2026 é anterior à instalação 10-05-2026.']);
    expect(check({ startDate: '2026-05-10', endDate: '2026-05-10' }).errors).toEqual([]);
  });

  test('recusa instalar antes de o servico existir', () => {
    expect(check({ startDate: '2025-12-31', activationDate: '2026-01-01' }).errors)
      .toEqual(['Data de instalação 31-12-2025 é anterior à ativação do serviço 01-01-2026.']);
  });

  test('sem ativacao conhecida so restam as outras regras', () => {
    expect(check({ startDate: '2020-01-01', activationDate: null }).errors).toEqual([]);
  });

  test('data impossivel nao passa por silencio', () => {
    // 31 de fevereiro normalizaria para marco se ninguem olhasse.
    expect(check({ startDate: '2026-02-31' }).errors).toEqual(['Data de instalação inválida.']);
    expect(check({ endDate: 'ontem' }).errors).toEqual(['Data de saída inválida.']);
  });

  test('campos ausentes ou vazios nao inventam erros', () => {
    expect(check({})).toEqual({ errors: [], warnings: [] });
    expect(check({ startDate: '', endDate: null })).toEqual({ errors: [], warnings: [] });
  });

  test('todayIso da o dia em AAAA-MM-DD', () => {
    expect(todayIso(today)).toBe('2026-08-28');
  });
});
