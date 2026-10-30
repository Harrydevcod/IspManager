// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { placeNodes, useMapLayout } from './useMapLayout';

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let saved: Array<{ nodeKey: string; x: number; y: number }> = [];

vi.mock('../../lib/auth', () => ({
  authFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, json: async () => (init?.method ? { saved: 1, removed: saved.length } : { positions: saved }) };
  })
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('placeNodes', () => {
  const nodes = [
    { id: 'a', position: { x: 0, y: 0 }, selected: false },
    { id: 'b', position: { x: 10, y: 10 }, selected: true }
  ];

  test('a posição guardada ganha ao dagre; sem nada guardado, o mesmo array', () => {
    expect(placeNodes(nodes, new Map(), new Set())).toBe(nodes);
    expect(placeNodes(nodes, new Map([['a', { x: 5, y: 6 }]]), new Set())[0].position).toEqual({ x: 5, y: 6 });
  });

  test('a seleção por caixa só conta a partir de dois nós', () => {
    expect(placeNodes(nodes, new Map(), new Set(['a']))[0].selected).toBe(false);
    expect(placeNodes(nodes, new Map(), new Set(['a', 'b']))[0].selected).toBe(true);
  });
});

describe('useMapLayout', () => {
  let root: Root;
  let container: HTMLDivElement;
  let layout: ReturnType<typeof useMapLayout>;
  const errors: string[] = [];

  function Harness({ direction = 'TB' as const }) {
    layout = useMapLayout(direction, true, true, (message) => errors.push(message));
    return null;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    calls.length = 0;
    saved = [{ nodeKey: 'backbone:1', x: 100, y: 200 }];
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => { root.render(<Harness />); });
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const lastPut = () => calls.filter((call) => call.method === 'PUT').at(-1)?.body as {
    direction: string; positions: Array<{ nodeKey: string; x: number | null; y: number | null }>;
  } | undefined;

  test('carrega as posições da direção e guarda um arrasto só depois da pausa', async () => {
    expect(calls[0].url).toContain('/api/topology/positions?direction=TB');
    expect(layout.overrides.get('backbone:1')).toEqual({ x: 100, y: 200 });

    act(() => {
      layout.onDragStart([{ id: 'backbone:2' }]);
      layout.onNodesChange([{ type: 'position', id: 'backbone:2', position: { x: 7, y: 8 }, dragging: true }]);
      layout.onDragStop([{ id: 'backbone:2', position: { x: 7, y: 8 } }]);
    });
    expect(layout.overrides.get('backbone:2')).toEqual({ x: 7, y: 8 });
    expect(lastPut()).toBeUndefined();

    await act(async () => { vi.advanceTimersByTime(700); });
    expect(lastPut()).toEqual({ direction: 'TB', positions: [{ nodeKey: 'backbone:2', x: 7, y: 8 }] });
  });

  test('desfazer devolve o nó ao sítio anterior — ao dagre, se não tinha posição — e refazer repõe', async () => {
    act(() => {
      layout.onDragStart([{ id: 'backbone:1' }, { id: 'backbone:2' }]);
      layout.onDragStop([{ id: 'backbone:1', position: { x: 1, y: 1 } }, { id: 'backbone:2', position: { x: 2, y: 2 } }]);
    });
    act(() => { layout.undo(); });
    expect(layout.overrides.get('backbone:1')).toEqual({ x: 100, y: 200 });
    expect(layout.overrides.has('backbone:2')).toBe(false);
    expect(layout.canRedo).toBe(true);

    await act(async () => { vi.advanceTimersByTime(700); });
    expect(lastPut()?.positions).toEqual([
      { nodeKey: 'backbone:1', x: 100, y: 200 },
      { nodeKey: 'backbone:2', x: null, y: null }
    ]);

    act(() => { layout.redo(); });
    expect(layout.overrides.get('backbone:2')).toEqual({ x: 2, y: 2 });
    expect(layout.canUndo).toBe(true);
  });

  test('Ctrl+Z no mapa desfaz; num campo de texto não', () => {
    act(() => {
      layout.onDragStart([{ id: 'backbone:3' }]);
      layout.onDragStop([{ id: 'backbone:3', position: { x: 3, y: 3 } }]);
    });
    const input = document.createElement('input');
    document.body.append(input);
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); });
    expect(layout.overrides.has('backbone:3')).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })); });
    expect(layout.overrides.has('backbone:3')).toBe(false);
    input.remove();
  });

  test('reorganizar apaga a direção no servidor e limpa o mapa e o histórico', async () => {
    await act(async () => { await layout.reset(); });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining('direction=TB') });
    expect(layout.overrides.size).toBe(0);
    expect(layout.canUndo).toBe(false);
    expect(errors).toEqual([]);
  });
});
