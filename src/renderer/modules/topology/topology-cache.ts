import type { TopologyBackboneBranch } from '../../../shared/topology';

type BranchLoader = (catalogId: number) => Promise<TopologyBackboneBranch>;

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export function createTopologyBranchCache(loader: BranchLoader) {
  const values = new Map<number, TopologyBackboneBranch>();
  const requests = new Map<number, Promise<TopologyBackboneBranch>>();
  const errors = new Map<number, Error>();

  function load(catalogId: number): Promise<TopologyBackboneBranch> {
    const cached = values.get(catalogId);
    if (cached) return Promise.resolve(cached);
    const pending = requests.get(catalogId);
    if (pending) return pending;

    const request = loader(catalogId)
      .then((branch) => {
        values.set(catalogId, branch);
        errors.delete(catalogId);
        return branch;
      })
      .catch((reason: unknown) => {
        errors.set(catalogId, toError(reason));
        throw reason;
      })
      .finally(() => requests.delete(catalogId));
    requests.set(catalogId, request);
    return request;
  }

  function retry(catalogId: number): Promise<TopologyBackboneBranch> {
    values.delete(catalogId);
    errors.delete(catalogId);
    return load(catalogId);
  }

  /**
   * Deita fora tudo o que já foi lido. Sem isto, "atualizar" continuava a servir
   * ramos anteriores à CPE que acabou de ser ligada. Os pedidos em voo também
   * saem: o próximo `load` volta a pedir em vez de aproveitar a resposta velha.
   */
  function clear(): void {
    values.clear();
    requests.clear();
    errors.clear();
  }

  return {
    load,
    retry,
    clear,
    peek: (catalogId: number) => values.get(catalogId),
    error: (catalogId: number) => errors.get(catalogId)
  };
}
