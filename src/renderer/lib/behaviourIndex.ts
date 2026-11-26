import { apiUrl } from './api';
import { useEffect, useState } from 'react';
import { authFetch } from './auth';
import type { ClientBehaviour, PaymentBehaviourReport } from '../types';

/**
 * A letra de cada cliente, à mão de quem desenha uma lista.
 *
 * Os ecrãs de cobrança já carregam os seus próprios dados; a classificação vem
 * de uma segunda leitura do mesmo read model, indexada por cliente. Uma consulta
 * local de milissegundos por ecrã — se um dia doer, nasce aqui um provider, não
 * antes.
 *
 * Falhar não estraga a lista: sem índice, as colunas da classe ficam vazias e o
 * resto do ecrã continua a servir. A cobrança não pode parar porque uma letra
 * não chegou.
 */
export type BehaviourIndex = {
  byClient: Map<number, ClientBehaviour>;
  loading: boolean;
};

export function useBehaviourIndex(): BehaviourIndex {
  const [byClient, setByClient] = useState<Map<number, ClientBehaviour>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await authFetch(apiUrl('/api/finance/payment-behaviour'));
        if (!response.ok) return;
        const report = await response.json() as PaymentBehaviourReport;
        if (alive) setByClient(new Map(report.clients.map((client) => [client.clientId, client])));
      } catch {
        // Sem classificação, as colunas ficam vazias; a lista serve na mesma.
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return { byClient, loading };
}
