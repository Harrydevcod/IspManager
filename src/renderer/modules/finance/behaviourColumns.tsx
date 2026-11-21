import { ScorePill } from './ScorePill';
import { PAYMENT_CONFIDENCE_LABELS } from '../../../shared/payment-score';
import type { DataTableColumn } from '../../components/DataTable';
import type { BehaviourIndex } from '../../lib/behaviourIndex';

/**
 * A classificação do cliente nas listas onde se cobra e se decide.
 *
 * Uma coluna por dado, como manda a casa — nada empilhado numa célula. Só a
 * classe fica visível: é a que muda a conversa de quem liga a cobrar. As outras
 * quatro detalham um juízo que a letra já resume, e voltam num clique em
 * "Colunas" — a 1225 px a tabela tem 919 px e não chegam para tudo.
 */

export const BEHAVIOUR_HEADERS = ['Classe', 'Pontuação', 'Confiança', 'Atraso médio', 'Avaliadas'];

/** Tudo menos a classe começa escondido. */
export const BEHAVIOUR_HIDDEN = BEHAVIOUR_HEADERS.slice(1);

/** A largura de cada uma, pela ordem de `BEHAVIOUR_HEADERS`. */
export const BEHAVIOUR_WIDTHS = '116px 92px 116px 112px 96px';

export function behaviourColumns<T>(
  clientIdOf: (row: T) => number,
  index: BehaviourIndex
): DataTableColumn<T>[] {
  const of = (row: T) => index.byClient.get(clientIdOf(row));
  // Enquanto a leitura não chega, a célula fica vazia em vez de dizer uma
  // coisa que vai mudar a seguir.
  const vazio = <span aria-hidden>&nbsp;</span>;

  return [
    {
      header: 'Classe',
      sortValue: (row) => of(row)?.score ?? null,
      defaultDirection: 'desc',
      cell: (row) => {
        const client = of(row);
        return client ? <ScorePill letter={client.letter} /> : vazio;
      }
    },
    {
      header: 'Pontuação',
      align: 'center',
      sortValue: (row) => of(row)?.score ?? null,
      defaultDirection: 'desc',
      cell: (row) => {
        const client = of(row);
        if (!client) return vazio;
        return client.letter === null ? <span>—</span> : <b>{client.score}</b>;
      }
    },
    {
      header: 'Confiança',
      align: 'center',
      sortValue: (row) => of(row)?.evaluated ?? null,
      defaultDirection: 'desc',
      cell: (row) => {
        const confidence = of(row)?.confidence;
        return confidence ? <span>{PAYMENT_CONFIDENCE_LABELS[confidence]}</span> : <span>—</span>;
      }
    },
    {
      header: 'Atraso médio',
      align: 'center',
      sortValue: (row) => (of(row)?.evaluated ? of(row)!.avgDelayDays : null),
      defaultDirection: 'desc',
      cell: (row) => {
        const client = of(row);
        return client?.evaluated ? <span>{client.avgDelayDays} d</span> : <span>—</span>;
      }
    },
    {
      header: 'Avaliadas',
      align: 'center',
      sortValue: (row) => of(row)?.evaluated ?? null,
      defaultDirection: 'desc',
      cell: (row) => {
        const client = of(row);
        return client ? <span>{client.evaluated}</span> : vazio;
      }
    }
  ];
}
