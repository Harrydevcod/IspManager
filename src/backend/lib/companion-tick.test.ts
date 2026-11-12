import { describe, expect, test, vi } from 'vitest';
import { runCompanionTick, type CompanionTickDeps } from './companion-tick';

function deps(over: Partial<CompanionTickDeps> = {}): CompanionTickDeps {
  return {
    sync: vi.fn(async () => ({ online: true, pushed: false, syncRequested: false })),
    pullEvents: vi.fn(async () => ({ pulled: 0, acked: true })),
    drainSms: vi.fn(async () => undefined),
    pollSms: vi.fn(async () => undefined),
    canWrite: () => true,
    ...over
  };
}

describe('runCompanionTick', () => {
  test('the minute tick leaves the SMS queue to its own timer', async () => {
    const d = deps();
    await runCompanionTick(false, d);
    expect(d.pullEvents).toHaveBeenCalledTimes(1);
    expect(d.drainSms).not.toHaveBeenCalled();
  });

  test('a request from the phone drains and polls the SMS queue at once', async () => {
    const d = deps({ sync: vi.fn(async () => ({ online: true, pushed: true, syncRequested: true })) });
    await runCompanionTick(false, d);
    expect(d.drainSms).toHaveBeenCalledTimes(1);
    expect(d.pollSms).toHaveBeenCalledTimes(1);
  });

  test('an expired licence still syncs but never dispatches SMS', async () => {
    const d = deps({ canWrite: () => false });
    await runCompanionTick(true, d);
    expect(d.drainSms).not.toHaveBeenCalled();
    expect(d.pollSms).toHaveBeenCalledTimes(1);
  });

  test('overlap: the minute tick skips, the button waits and runs its own exchange', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let running = 0;
    let maxRunning = 0;
    const sync = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running -= 1;
      return { online: true, pushed: true, syncRequested: false };
    });
    const d = deps({ sync });

    const first = runCompanionTick(false, d);
    expect(await runCompanionTick(false, d)).toBeNull();
    const clicked = runCompanionTick(true, d);
    release();
    await first;
    expect(await clicked).not.toBeNull();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
  });
});
