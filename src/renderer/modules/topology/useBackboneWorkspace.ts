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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<BackboneDeviceDetail | null>(null);
  const [backboneQuery, setBackboneQuery] = useState('');
  const [assignmentQuery, setAssignmentQuery] = useState('');
  const [unlinkedQuery, setUnlinkedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<BackboneStatus | undefined>();
  const [backbonePage, setBackbonePage] = useState(1);
  const [assignmentPage, setAssignmentPage] = useState(1);
  const [unlinkedPage, setUnlinkedPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationState, setMutationState] = useState<BackboneMutationState>(idleMutationState);
  const requestVersion = useRef(0);
  const detailRequestVersion = useRef(0);
  const initialLoad = useRef(true);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    const normalizedBackboneQuery = backboneQuery.trim() || undefined;
    const normalizedAssignmentQuery = assignmentQuery.trim() || undefined;
    const normalizedUnlinkedQuery = unlinkedQuery.trim() || undefined;
    setLoading(true);
    setError(null);
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
    const failure = results.find((result) => result.status === 'rejected');
    setError(failure?.status === 'rejected' ? message(failure.reason) : null);
    setLoading(false);
  }, [api, assignmentPage, assignmentQuery, backbonePage, backboneQuery, statusFilter, unlinkedPage, unlinkedQuery]);

  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      void refresh();
      return;
    }
    requestVersion.current += 1;
    const timer = window.setTimeout(() => { void refresh(); }, 300);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const version = ++detailRequestVersion.current;
    if (selectedId === null) {
      setSelected(null);
      return;
    }
    setSelected(null);
    void api.getBackbone(selectedId).then((detail) => {
      if (version === detailRequestVersion.current) setSelected(detail);
    }).catch((detailError: unknown) => {
      if (version === detailRequestVersion.current) setError(message(detailError));
    });
  }, [api, selectedId]);

  const createBackbone = useCallback(async (input: BackboneWriteInput) => {
    setMutationState(pendingMutationState());
    try {
      const created = await api.createBackbone(input);
      setSelectedId(created.id);
      setSelected(created);
      await refresh();
      onMutation();
      setMutationState(idleMutationState());
      return created;
    } catch (mutationError) {
      setMutationState(failedMutationState(mutationFailure('createBackbone', { input }, mutationError)));
      return null;
    }
  }, [api, onMutation, refresh]);

  const updateBackbone = useCallback(async (id: number, input: BackboneWriteInput) => {
    setMutationState(pendingMutationState());
    try {
      const updated = await api.updateBackbone(id, input);
      setSelected(updated);
      await refresh();
      onMutation();
      setMutationState(idleMutationState());
      return updated;
    } catch (mutationError) {
      setMutationState(failedMutationState(mutationFailure('updateBackbone', { id, input }, mutationError)));
      return null;
    }
  }, [api, onMutation, refresh]);

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
    await refresh();
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
  }, [api, onMutation, refresh]);

  const transferAssignment = useCallback(async (
    assignmentId: number, backboneDeviceId: number, reason: string | null = null
  ) => {
    const context = { assignmentId, backboneDeviceId, reason };
    setMutationState(pendingMutationState());
    try {
      const result = await api.linkAssignment(assignmentId, backboneDeviceId, reason);
      await refresh();
      onMutation();
      setMutationState(idleMutationState());
      return result;
    } catch (mutationError) {
      setMutationState(failedMutationState(mutationFailure('transferAssignment', context, mutationError)));
      return null;
    }
  }, [api, onMutation, refresh]);

  const unlinkAssignment = useCallback(async (assignmentId: number, reason: string | null = null) => {
    setMutationState(pendingMutationState());
    try {
      const result = await api.unlinkAssignment(assignmentId, reason);
      await refresh();
      onMutation();
      setMutationState(idleMutationState());
      return result;
    } catch (mutationError) {
      const failure = mutationFailure('unlinkAssignment', { assignmentId, reason }, mutationError);
      setMutationState(failedMutationState(failure, [assignmentId], { [assignmentId]: failure.message }));
      return null;
    }
  }, [api, onMutation, refresh]);

  const selectBackbone = useCallback((id: number | null) => { setSelectedId(id); }, []);

  return useMemo(() => ({
    backbones, selectedId, selected, assignments, unlinked,
    query: backboneQuery, backboneQuery, assignmentQuery, unlinkedQuery,
    backboneStatusFilter: statusFilter, statusFilter, loading, error, mutationState,
    setQuery: setBackboneQuery, setBackboneQuery, setAssignmentQuery, setUnlinkedQuery,
    setBackboneStatusFilter: setStatusFilter, setStatusFilter,
    setBackbonePage, setAssignmentPage, setUnlinkedPage,
    selectBackbone,
    refresh,
    createBackbone,
    updateBackbone,
    linkAssignments,
    transferAssignment,
    unlinkAssignment
  }), [assignmentQuery, assignments, backboneQuery, backbones, createBackbone, error, linkAssignments, loading, mutationState, refresh, selectBackbone, selected, selectedId, statusFilter, transferAssignment, unlinkAssignment, unlinked, unlinkedQuery, updateBackbone]);
}
