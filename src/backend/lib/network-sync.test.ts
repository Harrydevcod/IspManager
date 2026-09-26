import { describe, expect, test } from 'vitest';
import { createSyncTrigger } from './network-sync';

describe('createSyncTrigger', () => {
  test('pedidos durante uma passagem juntam-se numa única passagem seguinte', async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const trigger = createSyncTrigger(() => {
      runs += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    });

    trigger();
    trigger();
    trigger();
    expect(runs).toBe(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
  });

  test('uma passagem que falha não trava as seguintes', async () => {
    let runs = 0;
    const trigger = createSyncTrigger(async () => {
      runs += 1;
      throw new Error('router em baixo');
    });
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 0));
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
  });
});
