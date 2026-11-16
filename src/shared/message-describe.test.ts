import { describe, expect, test } from 'vitest';
import { describePeriods, describeServiceLines, joinPt, toGsm7 } from './message-describe';

describe('joinPt', () => {
  test('junta com vírgulas e "e" antes do último', () => {
    expect(joinPt([])).toBe('');
    expect(joinPt(['a'])).toBe('a');
    expect(joinPt(['a', 'b'])).toBe('a e b');
    expect(joinPt(['a', 'b', 'c'])).toBe('a, b e c');
  });
});

describe('describePeriods', () => {
  test('um mês por extenso', () => {
    expect(describePeriods([{ referenceMonth: '2026-10' }])).toBe('outubro de 2026');
  });
  test('vários meses do mesmo ano e de anos diferentes, sem repetir', () => {
    expect(describePeriods([{ referenceMonth: '2026-11' }, { referenceMonth: '2026-10' }, { referenceMonth: '2026-10' }])).toBe('outubro e novembro de 2026');
    expect(describePeriods([{ referenceMonth: '2026-01' }, { referenceMonth: '2025-12' }])).toBe('dezembro de 2025 e janeiro de 2026');
  });
  test('instalação e avulsa ficam no mês em que foram emitidas; nunca "-"', () => {
    expect(describePeriods([{ referenceMonth: 'INSTALACAO', invoiceDate: '2026-03-04' }])).toBe('março de 2026');
    expect(describePeriods([{ referenceMonth: 'AVULSA-12', invoiceDate: null, dueDate: '2026-07-10' }])).toBe('julho de 2026');
    expect(describePeriods([{ referenceMonth: 'AVULSA-12' }])).toBe('');
  });
  test('a anuidade audiovisual é o ano', () => {
    expect(describePeriods([{ referenceMonth: 'AV-2026-05' }])).toBe('ano de 2026');
    expect(describePeriods([{ referenceMonth: 'AV-2026-05' }, { referenceMonth: '2026-05' }])).toBe('maio de 2026 e ano de 2026');
  });
});

describe('describeServiceLines', () => {
  test('o plano dá nome à internet; as outras parcelas pelo tipo; sem repetidos', () => {
    expect(describeServiceLines([
      { kind: 'internet', description: 'Servico de Internet', planName: 'Standard' },
      { kind: 'audiovisual', description: 'Distribuição de Conteúdos Audiovisuais' },
      { kind: 'aluguer', description: 'Aluguer — Router' },
      { kind: 'aluguer', description: 'Aluguer — Antena' }
    ])).toBe('Internet Standard, Distribuição de Conteúdos Audiovisuais e aluguer de equipamento');
  });
  test('instalação, internet sem plano e artigos avulsos', () => {
    expect(describeServiceLines([{ kind: 'instalacao', description: 'Instalacao' }])).toBe('instalação');
    expect(describeServiceLines([{ kind: 'internet', description: 'Servico de Internet' }])).toBe('Internet');
    expect(describeServiceLines([{ kind: 'avulso', description: 'Cabo UTP 10 m' }, { kind: 'equipamento', description: 'Router TP-Link' }])).toBe('Cabo UTP 10 m e Router TP-Link');
    expect(describeServiceLines([])).toBe('');
  });
});

test('toGsm7 tira só o que sai do alfabeto GSM-7', () => {
  expect(toGsm7('instalação de março, Distribuição de Conteúdos')).toBe('instalacao de marco, Distribuicao de Conteudos');
  expect(toGsm7('é à ü')).toBe('é à ü');
});
