import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneDeviceSummary,
  BackbonePage,
  BackboneStatus,
  BackboneWriteInput
} from '../../../shared/backbone';
import { BackboneApiError, type BackboneApi } from './backbone-api';
import type { BackboneCatalogOption } from './backbone-api';

const PAGE_SIZE = 25;
const LINK_CONCURRENCY = 4;

function emptyPage<T>(page = 1): BackbonePage<T> {
  return { page, pageSize: PAGE_SIZE, total: 0, totalPages: 0, items: [] };
}

export type BackboneMutationOperation =
  | 'createBackbone'
  | 'updateBackbone'
  | 'linkAssignments'
  | 'transferAssignment'
  | 'unlinkAssignment';

export type BackboneMutationContext =
  | { input: BackboneWriteInput }
  | { id: number; input: BackboneWriteInput }
  | { assignmentIds: number[]; assignmentId?: number; backboneDeviceId: number; reason: string | null }
  | { assignmentId: number; backboneDeviceId: number; reason: string | null }
  | { assignmentId: number; reason: string | null };

export type BackboneMutationFailure = {
  status: number | null;
  operation: BackboneMutationOperation;
  message: string;
  context: BackboneMutationContext;
};

export type BackboneMutationConflict = BackboneMutationFailure & { status: 409 };

export type BackboneMutationState = {
  pending: boolean;
  error: string | null;
  failure: BackboneMutationFailure | null;
  conflict: BackboneMutationConflict | null;
  conflicts: readonly BackboneMutationConflict[];
  failedAssignmentIds: number[];
  assignmentErrors: Readonly<Record<number, string>>;
  assignmentFailures: Readonly<Record<number, BackboneMutationFailure>>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível concluir a alteração.';
}

function idleMutationState(): BackboneMutationState {
  return {
    pending: false, error: null, failure: null, conflict: null, conflicts: [],
    failedAssignmentIds: [], assignmentErrors: {}, assignmentFailures: {}
  };
}

function pendingMutationState(): BackboneMutationState {
  return { ...idleMutationState(), pending: true };
}

function mutationFailure(
  operation: BackboneMutationOperation,
  context: BackboneMutationContext,
  error: unknown
): BackboneMutationFailure {
  return {
    status: error instanceof BackboneApiError ? error.status : null,
    operation,
    message: message(error),
    context
  };
}

function failedMutationState(
  failure: BackboneMutationFailure,
  failedAssignmentIds: number[] = [],
  assignmentErrors: Readonly<Record<number, string>> = {},
  assignmentFailures: Readonly<Record<number, BackboneMutationFailure>> = {},
  conflicts: readonly BackboneMutationConflict[] = failure.status === 409
    ? [{ ...failure, status: 409 }]
    : []
): BackboneMutationState {
  return {
    pending: false,
    error: failure.message,
    failure,
    conflict: conflicts[0] ?? null,
    conflicts,
    failedAssignmentIds,
    assignmentErrors,
    assignmentFailures
  };
}

async function settleBounded<T>(
  ids: readonly number[],
  work: (id: number) => Promise<T>
): Promise<Array<{ id: number; error?: unknown }>> {
  const results: Array<{ id: number; error?: unknown }> = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        await work(id);
        results.push({ id });
      } catch (error) {
        results.push({ id, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, ids.length) }, worker));
  return results;
}

export function useBackboneWorkspace(api: BackboneApi, onMutation: () => void) {
  const [backbones, setBackbones] = useState<BackbonePage<BackboneDeviceSummary>>(() => emptyPage());
  const [assignments, setAssignments] = useState<BackbonePage<BackboneAssignmentSummary>>(() => emptyPage());
  const [unlinked, setUnlinked] = useState<BackbonePage<BackboneAssignmentSummary>>(() => emptyPage());
  const [linked, setLinked] = useState<BackbonePage<BackboneAssignmentSummary>>(() => emptyPage());
  const [destinations, setDestinations] = useState<BackbonePage<BackboneDeviceSummary>>(() => emptyPage());
  const [catalogs, setCatalogs] = useState<BackboneCatalogOption[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<BackboneDeviceDetail | null>(null);
  const [backboneQuery, setBackboneQuery] = useState('');
  const [assignmentQuery, setAssignmentQuery] = useState('');
  const [unlinkedQuery, setUnlinkedQuery] = useState('');
  const [linkedQuery, setLinkedQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<BackboneStatus | undefined>();
  const [backbonePage, setBackbonePage] = useState(1);
  const [assignmentPage, setAssignmentPage] = useState(1);
  const [unlinkedPage, setUnlinkedPage] = useState(1);
  const [linkedPage, setLinkedPage] = useState(1);
  const [destinationPage, setDestinationPage] = useState(1);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const [linkedError, setLinkedError] = useState<string | null>(null);
  const [destinationLoading, setDestinationLoading] = useState(true);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backboneLoading, setBackboneLoading] = useState(true);
  const [assignmentLoading, setAssignmentLoading] = useState(true);
  const [unlinkedLoading, setUnlinkedLoading] = useState(true);
  const [backboneError, setBackboneError] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [unlinkedError, setUnlinkedError] = useState<string | null>(null);
  const [mutationState, setMutationState] = useState<BackboneMutationState>(idleMutationState);
  const requestVersion = useRef(0);
  const detailRequestVersion = useRef(0);
  const linkedRequestVersion = useRef(0);
  const linkedSelection = useRef<number | null>(null);
  const destinationRequestVersion = useRef(0);
  const destinationInitialLoad = useRef(true);
  const initialLoad = useRef(true);

  const refreshPrimary = useCallback(async () => {
    const version = ++requestVersion.current;
    const normalizedBackboneQuery = backboneQuery.trim() || undefined;
    const normalizedAssignmentQuery = assignmentQuery.trim() || undefined;
    const normalizedUnlinkedQuery = unlinkedQuery.trim() || undefined;
    setLoading(true);
    setError(null);
    setBackboneLoading(true);
    setAssignmentLoading(true);
    setUnlinkedLoading(true);
    setBackboneError(null);
    setAssignmentError(null);
    setUnlinkedError(null);
    const results = await Promise.allSettled([
      api.listBackbones({ page: backbonePage, pageSize: PAGE_SIZE, status: statusFilter, query: normalizedBackboneQuery }),
      api.listAssignments({ page: assignmentPage, pageSize: PAGE_SIZE, mapping: 'all', query: normalizedAssignmentQuery }),
      api.listAssignments({ page: unlinkedPage, pageSize: PAGE_SIZE, mapping: 'unlinked', query: normalizedUnlinkedQuery })
    ]);
    if (version !== requestVersion.current) return;
    const [nextBackbones, nextAssignments, nextUnlinked] = results;
    if (nextBackbones.status === 'fulfilled') setBackbones(nextBackbones.value);
    if (nextAssignments.status === 'fulfilled') setAssignments(nextAssignments.value);
    if (nextUnlinked.status === 'fulfilled') setUnlinked(nextUnlinked.value);
    setBackboneError(nextBackbones.status === 'rejected' ? message(nextBackbones.reason) : null);
    setAssignmentError(nextAssignments.status === 'rejected' ? message(nextAssignments.reason) : null);
    setUnlinkedError(nextUnlinked.status === 'rejected' ? message(nextUnlinked.reason) : null);
    setBackboneLoading(false);
    setAssignmentLoading(false);
    setUnlinkedLoading(false);
    const failure = results.find((result) => result.status === 'rejected');
    setError(failure?.status === 'rejected' ? message(failure.reason) : null);
    setLoading(false);
  }, [api, assignmentPage, assignmentQuery, backbonePage, backboneQuery, statusFilter, unlinkedPage, unlinkedQuery]);

  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      void refreshPrimary();
      return;
    }
    requestVersion.current += 1;
    const timer = window.setTimeout(() => { void refreshPrimary(); }, 300);
    return () => window.clearTimeout(timer);
  }, [refreshPrimary]);

  const loadSelectedDetail = useCallback(async () => {
    const version = ++detailRequestVersion.current;
    if (selectedId === null) {
      setSelected(null);
      return null;
    }
    setSelected(null);
    try {
      const detail = await api.getBackbone(selectedId);
      if (version === detailRequestVersion.current) setSelected(detail);
      return detail;
    } catch (detailError) {
      if (version === detailRequestVersion.current) setError(message(detailError));
      return null;
    }
  }, [api, selectedId]);

  useEffect(() => {
    void loadSelectedDetail();
  }, [loadSelectedDetail]);

  const loadLinked = useCallback(async () => {
    if (selectedId === null) {
      setLinked(emptyPage());
      setLinkedLoading(false);
      setLinkedError(null);
      return;
    }
    const version = ++linkedRequestVersion.current;
    setLinkedLoading(true);
    setLinkedError(null);
    try {
      const result = await api.listAssignments({
        page: linkedPage,
        pageSize: PAGE_SIZE,
        mapping: 'linked',
        backboneDeviceId: selectedId,
        query: linkedQuery.trim() || undefined
      });
      if (version === linkedRequestVersion.current) setLinked(result);
    } catch (loadError) {
      if (version === linkedRequestVersion.current) setLinkedError(message(loadError));
    } finally {
      if (version === linkedRequestVersion.current) setLinkedLoading(false);
    }
  }, [api, linkedPage, linkedQuery, selectedId]);

  useEffect(() => {
    if (selectedId === null) {
      linkedSelection.current = null;
      void loadLinked();
      return;
    }
    if (linkedSelection.current !== selectedId) {
      linkedSelection.current = selectedId;
      void loadLinked();
      return;
    }
    linkedRequestVersion.current += 1;
    const timer = window.setTimeout(() => { void loadLinked(); }, 300);
    return () => window.clearTimeout(timer);
  }, [loadLinked, selectedId]);

  const loadDestinations = useCallback(async () => {
    const version = ++destinationRequestVersion.current;
    setDestinationLoading(true);
    setDestinationError(null);
    try {
      const result = await api.listBackbones({
        page: destinationPage,
        pageSize: PAGE_SIZE,
        status: 'active',
        query: destinationQuery.trim() || undefined
      });
      if (version === destinationRequestVersion.current) setDestinations(result);
    } catch (loadError) {
      if (version === destinationRequestVersion.current) setDestinationError(message(loadError));
    } finally {
      if (version === destinationRequestVersion.current) setDestinationLoading(false);
    }
  }, [api, destinationPage, destinationQuery]);

  useEffect(() => {
    if (destinationInitialLoad.current) {
      destinationInitialLoad.current = false;
      void loadDestinations();
      return;
    }
    destinationRequestVersion.current += 1;
    const timer = window.setTimeout(() => { void loadDestinations(); }, 300);
    return () => window.clearTimeout(timer);
  }, [loadDestinations]);

  const loadCatalogs = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalogs(await api.listCatalogs());
    } catch (loadError) {
      setCatalogError(message(loadError));
    } finally {
      setCatalogLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadCatalogs();
  }, [loadCatalogs]);

  const refreshCollections = useCallback(async () => {
    await Promise.all([refreshPrimary(), loadLinked(), loadDestinations()]);
  }, [loadDestinations, loadLinked, refreshPrimary]);

  const revalidateSelected = useCallback(async () => {
    await Promise.all([refreshCollections(), loadSelectedDetail()]);
  }, [loadSelectedDetail, refreshCollections]);

  const createBackbone = useCallback(async (input: BackboneWriteInput) => {
    setMutationState(pendingMutationState());
    try {
      const created = await api.createBackbone(input);
      setSelectedId(created.id);
      setSelected(created);
      await refreshCollections();
      onMutation();
      setMutationState(idleMutationState());
      return created;
    } catch (mutationError) {
      setMutationState(failedMutationState(mutationFailure('createBackbone', { input }, mutationError)));
      return null;
    }
  }, [api, onMutation, refreshCollections]);

  const updateBackbone = useCallback(async (id: number, input: BackboneWriteInput) => {
    setMutationState(pendingMutationState());
    try {
      const updated = await api.updateBackbone(id, input);
      setSelected(updated);
      await refreshCollections();
      onMutation();
      setMutationState(idleMutationState());
      return updated;
    } catch (mutationError) {
      const failure = mutationFailure('updateBackbone', { id, input }, mutationError);
      await revalidateSelected();
      setMutationState(failedMutationState(failure));
      return null;
    }
  }, [api, onMutation, refreshCollections, revalidateSelected]);

  const linkAssignments = useCallback(async (
    assignmentIds: number[], backboneDeviceId: number, reason: string | null = null
  ) => {
    const uniqueIds = [...new Set(assignmentIds)];
    const context = { assignmentIds: uniqueIds, backboneDeviceId, reason };
    setMutationState(pendingMutationState());
    const results = await settleBounded(uniqueIds, (assignmentId) => (
      api.linkAssignment(assignmentId, backboneDeviceId, reason)
    ));
    const byAssignmentId = new Map(results.map((result) => [result.id, result]));
    const failures = uniqueIds.flatMap((assignmentId) => {
      const result = byAssignmentId.get(assignmentId);
      return result?.error !== undefined ? [{ id: assignmentId, error: result.error }] : [];
    });
    const successful = results.length - failures.length;
    const assignmentErrors = Object.fromEntries(failures.map((failure) => [failure.id, message(failure.error)]));
    await revalidateSelected();
    if (successful > 0) onMutation();
    const assignmentFailures = Object.fromEntries(failures.map((failure) => [
      failure.id,
      mutationFailure('linkAssignments', { ...context, assignmentId: failure.id }, failure.error)
    ])) as Record<number, BackboneMutationFailure>;
    const orderedFailures = failures.map((failure) => assignmentFailures[failure.id]);
    const conflicts: BackboneMutationConflict[] = orderedFailures
      .filter((failure) => failure.status === 409)
      .map((failure) => ({ ...failure, status: 409 as const }));
    const firstFailure = orderedFailures[0] ?? null;
    setMutationState(firstFailure
      ? {
          ...failedMutationState(
            firstFailure,
            failures.map((failure) => failure.id),
            assignmentErrors,
            assignmentFailures,
            conflicts
          ),
          error: successful === 0 ? firstFailure.message : null
        }
      : idleMutationState());
    return { successful, failedAssignmentIds: failures.map((failure) => failure.id), assignmentErrors };
  }, [api, onMutation, revalidateSelected]);

  const transferAssignment = useCallback(async (
    assignmentId: number, backboneDeviceId: number, reason: string | null = null
  ) => {
    const context = { assignmentId, backboneDeviceId, reason };
    setMutationState(pendingMutationState());
    try {
      const result = await api.linkAssignment(assignmentId, backboneDeviceId, reason);
      await revalidateSelected();
      onMutation();
      setMutationState(idleMutationState());
      return result;
    } catch (mutationError) {
      const failure = mutationFailure('transferAssignment', context, mutationError);
      await revalidateSelected();
      setMutationState(failedMutationState(failure, [assignmentId], { [assignmentId]: failure.message }));
      return null;
    }
  }, [api, onMutation, revalidateSelected]);

  const unlinkAssignment = useCallback(async (assignmentId: number, reason: string | null = null) => {
    setMutationState(pendingMutationState());
    try {
      const result = await api.unlinkAssignment(assignmentId, reason);
      await revalidateSelected();
      onMutation();
      setMutationState(idleMutationState());
      return result;
    } catch (mutationError) {
      const failure = mutationFailure('unlinkAssignment', { assignmentId, reason }, mutationError);
      await revalidateSelected();
      setMutationState(failedMutationState(failure, [assignmentId], { [assignmentId]: failure.message }));
      return null;
    }
  }, [api, onMutation, revalidateSelected]);

  const selectBackbone = useCallback((id: number | null) => {
    setLinkedQuery('');
    setLinkedPage(1);
    setSelectedId(id);
  }, []);

  return useMemo(() => ({
    backbones, selectedId, selected, assignments, unlinked, linked, destinations, catalogs,
    query: backboneQuery, backboneQuery, assignmentQuery, unlinkedQuery, linkedQuery, destinationQuery,
    backboneStatusFilter: statusFilter, statusFilter, loading, error,
    backboneLoading, assignmentLoading, unlinkedLoading,
    backboneError, assignmentError, unlinkedError,
    linkedLoading, linkedError, destinationLoading, destinationError,
    catalogLoading, catalogError, mutationState,
    setQuery: setBackboneQuery, setBackboneQuery, setAssignmentQuery, setUnlinkedQuery, setLinkedQuery,
    setDestinationQuery,
    setBackboneStatusFilter: setStatusFilter, setStatusFilter,
    setBackbonePage, setAssignmentPage, setUnlinkedPage, setLinkedPage, setDestinationPage,
    selectBackbone,
    refresh: refreshCollections,
    refreshLinked: loadLinked,
    refreshDestinations: loadDestinations,
    refreshCatalogs: loadCatalogs,
    createBackbone,
    updateBackbone,
    linkAssignments,
    transferAssignment,
    unlinkAssignment
  }), [assignmentError, assignmentLoading, assignmentQuery, assignments, backboneError, backboneLoading, backboneQuery, backbones, catalogError, catalogLoading, catalogs, createBackbone, destinationError, destinationLoading, destinationQuery, destinations, error, linkAssignments, linked, linkedError, linkedLoading, linkedQuery, loadCatalogs, loadDestinations, loadLinked, loading, mutationState, refreshCollections, selectBackbone, selected, selectedId, statusFilter, transferAssignment, unlinkAssignment, unlinked, unlinkedError, unlinkedLoading, unlinkedQuery, updateBackbone]);
}
