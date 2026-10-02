/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WanRate } from './router-api';
import { useTween } from './WanTraffic';

let shown: WanRate[] = [];
function Probe({ target }: { target: WanRate[] }) {
  shown = useTween(target, 600);
  return null;
}

const rate = (downBps: number): WanRate[] => [{ name: 'WAN1', running: true, downBps, upBps: downBps / 10 }];

let frames: FrameRequestCallback[] = [];
let root: Root;
let hidden = false;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = [];
  hidden = false;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Corre os frames pendentes como se tivessem passado `at` ms desde o início. */
async function frame(at: number) {
  const pending = frames;
  frames = [];
  await act(async () => { pending.forEach((cb) => cb(at)); });
}

test('desliza da amostra anterior para a nova', async () => {
  await act(async () => { root.render(<Probe target={rate(1_000)} />); });
  expect(shown[0].downBps).toBe(1_000);

  await act(async () => { root.render(<Probe target={rate(3_000)} />); });
  expect(shown[0].downBps).toBe(1_000);
  await frame(300);
  expect(shown[0].downBps).toBe(2_000);
  await frame(600);
  expect(shown[0].downBps).toBe(3_000);
  expect(frames).toHaveLength(0);
});

test('com a janela escondida o valor novo entra logo', async () => {
  await act(async () => { root.render(<Probe target={rate(1_000)} />); });
  hidden = true;
  await act(async () => { root.render(<Probe target={rate(3_000)} />); });
  expect(shown[0].downBps).toBe(3_000);
  expect(frames).toHaveLength(0);
});
