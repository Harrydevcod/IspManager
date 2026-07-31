import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  TopologyBackboneBranch,
  TopologyNode,
  TopologySearchResult,
  TopologySnapshot
} from '../../../shared/topology';
import { createTopologyApi, type TopologyApi } from './topology-api';
import { createTopologyBranchCache } from './topology-cache';
import type { TopologyGraphFilters } from './topology-filters';
import type { SearchState } from './TopologyToolbar';

const defaultApi = createTopologyApi();

function addId(current: ReadonlySet<number>, id: number): Set<number> {
  return new Set(current).add(id);
}

function removeId(current: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(current);
  next.delete(id);
  return next;
}

function resultBackboneId(result: TopologySearchResult): number | null {
  if (result.node.kind === 'backbone') return result.node.backboneDeviceId;
  // O ramo a carregar é o do pai imediato: os ancestrais vêm ordenados da raiz
  // para baixo, e o primeiro backbone da cadeia é a cabeça (Starlink), não o AP
  // onde o resultado está pendurado.
  const ancestor = [...result.ancestors].reverse().find((item) => item.kind === 'backbone');
  const parsed = ancestor ? Number(ancestor.id.slice('backbone:'.length)) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function useTopologySnapshot(api: TopologyApi) {
  const requestRef = useRef<Promise<void> | null>(null);
  const [snapshot, setSnapshot] = useState<TopologySnapshot | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const loadSnapshot = useCallback((force = false) => {
    if (!force && requestRef.current) return requestRef.current;
    setGlobalError(null);
    const request = api.fetchSnapshot()
      .then(setSnapshot)
      .catch(() => setGlobalError('Não foi possível carregar a topologia.'))
      .finally(() => { requestRef.current = null; });
    requestRef.current = request;
    return request;
  }, [api]);
  useEffect(() => { void loadSnapshot(); }, [loadSnapshot]);
  return { snapshot, globalError, loadSnapshot };
}

function useTopologyBranches(api: TopologyApi) {
  const cache = useMemo(() => createTopologyBranchCache(api.fetchBranch), [api]);
  const [branches, setBranches] = useState(new Map<number, TopologyBackboneBranch>());
  const [expanded, setExpanded] = useState(new Set<number>());
  const [loadingBranches, setLoading] = useState(new Set<number>());
  const [branchErrors, setErrors] = useState(new Map<number, string>());
  const loadBranch = useCallback(async (catalogId: number, retry = false) => {
    setLoading((current) => addId(current, catalogId));
    setErrors((current) => {
      const next = new Map(current);
      next.delete(catalogId);
      return next;
    });
    try {
      const branch = await (retry ? cache.retry(catalogId) : cache.load(catalogId));
      setBranches((current) => new Map(current).set(catalogId, branch));
      return branch;
    } catch {
      setErrors((current) => new Map(current).set(
        catalogId,
        'Não foi possível carregar este ramo.'
      ));
      return null;
    } finally {
      setLoading((current) => removeId(current, catalogId));
    }
  }, [cache]);
  return {
    branches, expanded, loadingBranches, branchErrors, setExpanded, loadBranch
  };
}

function useServerTopologySearch(api: TopologyApi, filters: TopologyGraphFilters) {
  const sequenceRef = useRef(0);
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [searchResults, setSearchResults] = useState<TopologySearchResult[]>([]);
  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++sequenceRef.current;
    if (trimmed.length < 2) {
      setSearchResults([]);
      setSearchState('idle');
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchState('loading');
      void api.search(trimmed, filters, 50).then((response) => {
        if (sequence !== sequenceRef.current) return;
        setSearchResults(response.results);
        setSearchState('idle');
      }).catch(() => {
        if (sequence === sequenceRef.current) setSearchState('error');
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [api, filters, query]);
  return { query, setQuery, searchState, searchResults, setSearchResults };
}

export function useTopologyWorkspace(providedApi?: TopologyApi) {
  const api = providedApi ?? defaultApi;
  const snapshotState = useTopologySnapshot(api);
  const branchState = useTopologyBranches(api);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [filters, setFilters] = useState<TopologyGraphFilters>({});
  const search = useServerTopologySearch(api, filters);

  const toggleBranch = useCallback((catalogId: number) => {
    if (branchState.expanded.has(catalogId)) {
      branchState.setExpanded((current) => removeId(current, catalogId));
      return;
    }
    branchState.setExpanded((current) => addId(current, catalogId));
    if (!branchState.branches.has(catalogId)) void branchState.loadBranch(catalogId);
  }, [branchState]);

  const backboneIds = useMemo(
    () => snapshotState.snapshot?.backbones.map((item) => item.backboneDeviceId) ?? [],
    [snapshotState.snapshot]
  );
  const allBranchesExpanded = backboneIds.length > 0
    && backboneIds.every((id) => branchState.expanded.has(id));

  const toggleAllBranches = useCallback(() => {
    if (allBranchesExpanded) {
      // Fechar não deita fora os ramos: reabrir não repete pedidos.
      branchState.setExpanded(new Set());
      return;
    }
    branchState.setExpanded(new Set(backboneIds));
    backboneIds
      .filter((id) => !branchState.branches.has(id))
      .forEach((id) => void branchState.loadBranch(id));
  }, [allBranchesExpanded, backboneIds, branchState]);

  const retryBranch = useCallback((catalogId: number) => {
    branchState.setExpanded((current) => addId(current, catalogId));
    void branchState.loadBranch(catalogId, true);
  }, [branchState]);

  const selectSearchResult = useCallback(async (result: TopologySearchResult) => {
    let node: TopologyNode = result.node;
    const catalogId = resultBackboneId(result);
    if (catalogId !== null) {
      branchState.setExpanded((current) => addId(current, catalogId));
      const loaded = branchState.branches.get(catalogId)
        ?? await branchState.loadBranch(catalogId);
      node = result.node.kind === 'backbone'
        ? loaded?.backbone ?? result.node
        : loaded?.nodes.find((item) => item.id === result.node.id) ?? result.node;
    }
    setSelectedNode(node);
    search.setQuery('');
    search.setSearchResults([]);
    setPendingFocusId(node.id);
  }, [branchState, search]);

  return {
    ...snapshotState, ...branchState, ...search,
    selectedNode, pendingFocusId, filters, allBranchesExpanded,
    setSelectedNode, setPendingFocusId, setFilters,
    toggleBranch, toggleAllBranches, retryBranch, selectSearchResult
  };
}
