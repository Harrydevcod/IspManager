import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { BEHAVIOUR_HEADERS, BEHAVIOUR_HIDDEN, behaviourColumns } from './behaviourColumns';
import type { BehaviourIndex } from '../../lib/behaviourIndex';
import type { ClientBehaviour } from '../../types';

/**
 * O padrão que os três ecrãs de cobrança partilham. O que aqui se fixa é o que
 * não se pode partir em nenhum deles: uma coluna por dado, só a classe visível,
 * e nada a mentir enquanto a leitura não chega.
 */

const cliente = (over: Partial<ClientBehaviour> = {}): ClientBehaviour => ({
  clientId: 1,
  clientName: 'Antonio Silva',
  clientCode: 'C0001',
  zone: null,
  clientStatus: 'active',
  state: 'em_dia',
  overdueCve: 0,
  trend: 'flat',
  score: 91,
  letter: 'A',
  confidence: 'consolidada',
  evaluated: 7,
  onTime: 6,
  settled: 7,
  punctualityPct: 86,
  avgDelayDays: 1.9,
  recentEvaluated: 6,
  parts: { punctuality: 36, delay: 22, settled: 20, regularity: 13 },
  ...over
});

const indice = (clients: ClientBehaviour[], loading = false): BehaviourIndex => ({
  byClient: new Map(clients.map((c) => [c.clientId, c])),
  loading
});

type Linha = { clientId: number };
const colunas = (index: BehaviourIndex) => behaviourColumns<Linha>((row) => row.clientId, index);
const celula = (index: BehaviourIndex, header: string, row: Linha) => {
  const column = colunas(index).find((c) => c.header === header)!;
  return renderToStaticMarkup(<>{column.cell(row)}</>);
};

describe('as colunas da classificação nas listas', () => {
  test('uma coluna por dado, e só a classe começa visível', () => {
    expect(colunas(indice([])).map((c) => c.header)).toEqual(BEHAVIOUR_HEADERS);
    expect(BEHAVIOUR_HIDDEN).not.toContain('Classe');
    expect(BEHAVIOUR_HIDDEN).toHaveLength(BEHAVIOUR_HEADERS.length - 1);
  });

  test('mostra a letra, a pontuação e a confiança do cliente da linha', () => {
    const index = indice([cliente()]);
    expect(celula(index, 'Classe', { clientId: 1 })).toContain('Excelente');
    expect(celula(index, 'Pontuação', { clientId: 1 })).toContain('91');
    expect(celula(index, 'Confiança', { clientId: 1 })).toContain('Consolidada');
    expect(celula(index, 'Atraso médio', { clientId: 1 })).toContain('1.9');
    expect(celula(index, 'Avaliadas', { clientId: 1 })).toContain('7');
  });

  test('quem aguarda avaliação não leva pontuação nem confiança', () => {
    const index = indice([cliente({ letter: null, confidence: null, score: 0, evaluated: 0 })]);
    expect(celula(index, 'Classe', { clientId: 1 })).toContain('Por avaliar');
    expect(celula(index, 'Pontuação', { clientId: 1 })).toContain('—');
    expect(celula(index, 'Confiança', { clientId: 1 })).toContain('—');
    expect(celula(index, 'Atraso médio', { clientId: 1 })).toContain('—');
  });

  test('um cliente fora do índice não inventa nada', () => {
    // Acontece enquanto a leitura não chega, ou se ela falhar: a cobrança não
    // pode parar porque uma letra não veio.
    const index = indice([]);
    for (const header of BEHAVIOUR_HEADERS) {
      expect(celula(index, header, { clientId: 7 })).not.toContain('Excelente');
    }
  });

  test('ordenar pela classe usa a pontuação, e os sem letra caem para o fim', () => {
    const index = indice([
      cliente({ clientId: 1, score: 91 }),
      cliente({ clientId: 2, letter: null, score: 0, evaluated: 0 })
    ]);
    const classe = colunas(index).find((c) => c.header === 'Classe')!;
    expect(classe.sortValue!({ clientId: 1 })).toBe(91);
    // Vazio ordena sempre no fim, como manda a casa.
    expect(classe.sortValue!({ clientId: 99 })).toBeNull();
  });
});
