import { useCallback, useMemo, useState } from 'react';

export type SelectAllState = 'none' | 'some' | 'all';

export type RowSelection<K> = {
  selected: ReadonlySet<K>;
  count: number;
  isSelected: (key: K) => boolean;
  toggle: (key: K) => void;
  /** Header checkbox: seleciona todas as chaves visíveis ou limpa-as se já estiverem todas. */
  toggleVisible: (keys: readonly K[]) => void;
  /** Estado do checkbox de cabeçalho face às chaves visíveis. */
  visibleState: (keys: readonly K[]) => SelectAllState;
  /** Mantém apenas as seleções ainda presentes nas chaves dadas (ex.: após recarga). */
  retain: (keys: readonly K[]) => void;
  clear: () => void;
};

export function selectAllState<K>(selected: ReadonlySet<K>, keys: readonly K[]): SelectAllState {
  if (keys.length === 0) return 'none';
  let hit = 0;
  for (const key of keys) if (selected.has(key)) hit += 1;
  if (hit === 0) return 'none';
  return hit === keys.length ? 'all' : 'some';
}

export function useRowSelection<K>(): RowSelection<K> {
  const [selected, setSelected] = useState<Set<K>>(() => new Set<K>());

  const toggle = useCallback((key: K) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const toggleVisible = useCallback((keys: readonly K[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = keys.length > 0 && keys.every((key) => next.has(key));
      if (allSelected) for (const key of keys) next.delete(key);
      else for (const key of keys) next.add(key);
      return next;
    });
  }, []);

  const retain = useCallback((keys: readonly K[]) => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const allowed = new Set(keys);
      const next = new Set<K>();
      for (const key of current) if (allowed.has(key)) next.add(key);
      return next.size === current.size ? current : next;
    });
  }, []);

  const clear = useCallback(() => setSelected((current) => (current.size === 0 ? current : new Set<K>())), []);

  return useMemo<RowSelection<K>>(() => ({
    selected,
    count: selected.size,
    isSelected: (key) => selected.has(key),
    toggle,
    toggleVisible,
    visibleState: (keys) => selectAllState(selected, keys),
    retain,
    clear
  }), [selected, toggle, toggleVisible, retain, clear]);
}
