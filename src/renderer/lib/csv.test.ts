import { describe, expect, test } from 'vitest';
import { csvValue, toCsv } from './csv';

describe('csvValue', () => {
  test('neutraliza os arranques que o Excel lê como fórmula', () => {
    for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvValue(`${prefix}cmd|'/c calc'!A0`)).toBe(`"'${prefix}cmd|'/c calc'!A0"`);
    }
  });

  test('texto normal passa intacto entre aspas', () => {
    expect(csvValue('Sr. Silva')).toBe('"Sr. Silva"');
  });

  test('aspas são duplicadas para não partirem a célula', () => {
    expect(csvValue('diz "olá"')).toBe('"diz ""olá"""');
  });

  test('nulo e indefinido viram célula vazia', () => {
    expect(csvValue(null)).toBe('""');
    expect(csvValue(undefined)).toBe('""');
  });

  test('números não levam plica — o sinal negativo é do número', () => {
    expect(csvValue(1500)).toBe('"1500"');
    // Um negativo continua a ser prefixado: para o Excel `-1` numa célula de
    // texto é indistinguível do arranque de uma fórmula.
    expect(csvValue(-1500)).toBe(`"'-1500"`);
  });
});

describe('toCsv', () => {
  test('junta com ponto e vírgula e quebra de linha', () => {
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('"a";"b"\n"1";"2"');
  });

  test('sem linhas dá string vazia', () => {
    expect(toCsv([])).toBe('');
  });
});
