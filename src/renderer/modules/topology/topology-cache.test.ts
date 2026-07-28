import { describe, expect, test } from 'vitest';
import type { TopologyBackboneBranch } from '../../../shared/topology';
import { branchOne, branchTwo } from './topologyTestFixtures';
import { createTopologyBranchCache } from './topology-cache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('topology branch cache', () => {
  test('deduplicates concurrent and subsequent requests within one session', async () => {
    const pending = deferred<TopologyBackboneBranch>();
    let requests = 0;
    const cache = createTopologyBranchCache(() => {
      requests += 1;
      return pending.promise;
    });

    const first = cache.load(10);
    const second = cache.load(10);
    expect(requests).toBe(1);
    expect(second).toBe(first);
    pending.resolve(branchOne);
    expect(await first).toEqual(branchOne);
    expect(await cache.load(10)).toEqual(branchOne);
    expect(requests).toBe(1);
  });

  test('retries only the failed branch and preserves successful branch data', async () => {
    const attempts = new Map<number, number>();
    const cache = createTopologyBranchCache(async (id) => {
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      if (id === 10 && attempts.get(id) === 1) throw new Error('offline');
      return id === 10 ? branchOne : branchTwo;
    });

    await expect(cache.load(10)).rejects.toThrow('offline');
    expect(await cache.load(20)).toEqual(branchTwo);
    expect(cache.error(10)).toEqual(new Error('offline'));
    expect(await cache.retry(10)).toEqual(branchOne);
    expect(cache.peek(20)).toEqual(branchTwo);
    expect(attempts).toEqual(new Map([[10, 2], [20, 1]]));
  });

  test('keeps cache instances isolated by renderer session', async () => {
    let requests = 0;
    const loader = async () => {
      requests += 1;
      return branchOne;
    };
    const firstSession = createTopologyBranchCache(loader);
    const secondSession = createTopologyBranchCache(loader);

    await firstSession.load(10);
    await secondSession.load(10);
    expect(requests).toBe(2);
  });
});
