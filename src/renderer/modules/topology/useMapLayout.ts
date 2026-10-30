import type { NodeChange } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TopologyPosition } from '../../../shared/topology';
import { authFetch } from '../../lib/auth';
import type { TopologyDirection } from './topology-layout';

const API_BASE = 'http://127.0.0.1:3001';
/** Junta os arrastos seguidos num só pedido. */
const SAVE_DELAY_MS = 600;
const UNDO_LIMIT = 50;

type Point = { x: number; y: number };
/** `null` = o nó volta ao desenho automático. */
type Placement = Map<string, Point | null>;
type Step = { before: Placement; after: Placement };

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await authFetch(url, init);
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? `Pedido falhou (${response.status})`);
  return payload;
}

/** Aplica as posições guardadas e a seleção por caixa por cima do desenho do dagre. */
export function placeNodes<T extends { id: string; position: Point; selected?: boolean }>(
  nodes: T[],
  overrides: ReadonlyMap<string, Point>,
  boxSelection: ReadonlySet<string>
): T[] {
  // Um nó só é o clique de sempre (o inspetor manda); a caixa conta a partir de dois.
  const group = boxSelection.size > 1 ? boxSelection : null;
  if (overrides.size === 0 && !group) return nodes;
  return nodes.map((node) => {
    const position = overrides.get(node.id);
    const selected = Boolean(node.selected || group?.has(node.id));
    return position || selected !== node.selected ? { ...node, position: position ?? node.position, selected } : node;
  });
}

/**
 * Posições arrumadas à mão no mapa (0090): carregar por direção, arrastar,
 * gravar sozinho e desfazer. Os nós sem posição continuam a vir do dagre.
 */
export function useMapLayout(direction: TopologyDirection, active: boolean, canManage: boolean, onError: (message: string) => void) {
  const [overrides, setOverrides] = useState<Map<string, Point>>(() => new Map());
  const [boxSelection, setBoxSelection] = useState<Set<string>>(() => new Set());
  const [history, setHistory] = useState<{ undo: Step[]; redo: Step[] }>({ undo: [], redo: [] });
  const dragStart = useRef<Placement | null>(null);
  const pending = useRef<Placement>(new Map());
  const timer = useRef<number | null>(null);
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const boxSelectionRef = useRef(boxSelection);
  boxSelectionRef.current = boxSelection;
  // Num ref: quem chama passa muitas vezes uma função nova a cada render, e isso
  // não pode mudar o `flush` — o efeito de saída gravava a cada render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (pending.current.size === 0) return;
    const positions = [...pending.current].map(([nodeKey, point]) => ({ nodeKey, x: point?.x ?? null, y: point?.y ?? null }));
    pending.current = new Map();
    void request(`${API_BASE}/api/topology/positions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction, positions })
    }).catch((error: unknown) => onErrorRef.current(error instanceof Error ? error.message : 'Não foi possível guardar as posições'));
  }, [direction]);

  const queueSave = useCallback((placement: Placement) => {
    for (const [key, point] of placement) pending.current.set(key, point);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  }, [flush]);

  // Mudar de direção ou sair do mapa grava o que falta antes de trocar de desenho.
  useEffect(() => () => flush(), [flush]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setHistory({ undo: [], redo: [] });
    void request(`${API_BASE}/api/topology/positions?direction=${direction}`)
      .then((payload) => {
        if (cancelled) return;
        const rows = (payload as { positions?: TopologyPosition[] } | null)?.positions ?? [];
        setOverrides(new Map(rows.map((row) => [row.nodeKey, { x: row.x, y: row.y }])));
      })
      // Sem posições guardadas o mapa continua todo automático: não é motivo para alarmar.
      .catch(() => { if (!cancelled) setOverrides(new Map()); });
    return () => { cancelled = true; };
  }, [active, direction]);

  const apply = useCallback((placement: Placement) => {
    setOverrides((current) => {
      const next = new Map(current);
      for (const [key, point] of placement) {
        if (point) next.set(key, point);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moved: Placement = new Map();
    let selection: Set<string> | null = null;
    for (const change of changes) {
      if (change.type === 'position' && change.position && canManage) moved.set(change.id, change.position);
      if (change.type === 'select') {
        selection ??= new Set(boxSelectionRef.current);
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
      }
    }
    if (moved.size > 0) apply(moved);
    if (selection) setBoxSelection(selection);
  }, [apply, canManage]);
  const onDragStart = useCallback((nodes: ReadonlyArray<{ id: string }>) => {
    dragStart.current = new Map(nodes.map((node) => [node.id, overridesRef.current.get(node.id) ?? null]));
  }, []);

  const onDragStop = useCallback((nodes: ReadonlyArray<{ id: string; position: Point }>) => {
    const before = dragStart.current;
    dragStart.current = null;
    const after: Placement = new Map(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]));
    if (!before || after.size === 0) return;
    apply(after);
    setHistory((current) => ({ undo: [...current.undo, { before, after }].slice(-UNDO_LIMIT), redo: [] }));
    queueSave(after);
  }, [apply, queueSave]);

  const undo = useCallback(() => {
    const step = history.undo.at(-1);
    if (!step) return;
    setHistory({ undo: history.undo.slice(0, -1), redo: [...history.redo, step] });
    apply(step.before);
    queueSave(step.before);
  }, [apply, history, queueSave]);

  const redo = useCallback(() => {
    const step = history.redo.at(-1);
    if (!step) return;
    setHistory({ undo: [...history.undo, step], redo: history.redo.slice(0, -1) });
    apply(step.after);
    queueSave(step.after);
  }, [apply, history, queueSave]);

  /** Apaga tudo o que se arrumou nesta direção. Quem chama confirma antes. */
  const reset = useCallback(async () => {
    pending.current = new Map();
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    try {
      await request(`${API_BASE}/api/topology/positions?direction=${direction}`, { method: 'DELETE' });
      setOverrides(new Map());
      setHistory({ undo: [], redo: [] });
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : 'Não foi possível reorganizar o mapa');
    }
  }, [direction]);

  useEffect(() => {
    if (!active || !canManage) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
      else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, canManage, undo, redo]);

  return {
    overrides,
    boxSelection,
    arranged: overrides.size > 0,
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    onNodesChange,
    onDragStart,
    onDragStop,
    undo,
    redo,
    reset
  };
}
