import { Plus, RadioTower } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneWriteInput
} from '../../../shared/backbone';
import { Button } from '../../components';
import { useAuth } from '../../lib/auth';
import { createBackboneApi } from './backbone-api';
import { BackboneDetail } from './BackboneDetail';
import {
  BackboneEditorDialog,
  BackboneMappingDialog,
  BackboneUnlinkDialog,
  type MappingMode
} from './BackboneDialogs';
import { BackboneList } from './BackboneList';
import { useBackboneWorkspace } from './useBackboneWorkspace';
import './BackboneWorkspace.css';

/** Valores que a Descoberta traz da rede para o formulário de registo. */
export type BackbonePrefill = {
  ipAddress: string;
  macAddress: string | null;
  /** O nome que o aparelho anuncia, quando anuncia algum. */
  name?: string | null;
  /** O modelo que a rede respondeu — serve para escolher o item do catálogo. */
  model?: string | null;
};

export type BackboneWorkspaceProps = {
  /** Sobe quando o mapa regista ou liga uma unidade: refresca sem remontar. */
  revision?: number;
  onMutation: () => void;
  onViewTopology: (backboneDeviceId: number) => void;
  /** Abre o formulário de criação já preenchido (vem da aba Descoberta). */
  prefill?: BackbonePrefill | null;
  onPrefillHandled?: () => void;
};

type MappingState = {
  mode: MappingMode;
  initialAssignmentId: number | null;
  currentBackbone: BackboneDeviceDetail;
} | null;

export function BackboneWorkspace({
  revision = 0,
  onMutation,
  onViewTopology,
  prefill = null,
  onPrefillHandled
}: BackboneWorkspaceProps) {
  const auth = useAuth();
  const canManage = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const api = useMemo(() => createBackboneApi(), []);
  const workspace = useBackboneWorkspace(api, onMutation);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingBackbone, setEditingBackbone] = useState<BackboneDeviceDetail | null>(null);
  const [createPrefill, setCreatePrefill] = useState<BackbonePrefill | null>(null);
  const [mapping, setMapping] = useState<MappingState>(null);
  const [unlinking, setUnlinking] = useState<BackboneAssignmentSummary | null>(null);
  const [editorAttempted, setEditorAttempted] = useState(false);
  const [mappingAttempted, setMappingAttempted] = useState(false);
  const [unlinkAttempted, setUnlinkAttempted] = useState(false);
  const selectionOriginRef = useRef<{ id: number; element: HTMLElement | null } | null>(null);
  const restoreSelectionFocusRef = useRef(false);
  const mutationOpenerRef = useRef<HTMLElement | null>(null);
  const restoreMutationFocusRef = useRef(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const [isCompactViewport, setIsCompactViewport] = useState(false);

  const selected = workspace.selected;
  const selectedId = workspace.selectedId;
  // O `refresh` muda de identidade a cada mutação; guardá-lo numa ref mantém o
  // efeito preso apenas à revisão, senão refrescava duas vezes por mutação.
  const refreshRef = useRef(workspace.refresh);
  useEffect(() => { refreshRef.current = workspace.refresh; }, [workspace.refresh]);

  const firstRevision = useRef(true);
  useEffect(() => {
    if (firstRevision.current) {
      firstRevision.current = false;
      return;
    }
    void refreshRef.current();
  }, [revision]);

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const updateCompactState = (width: number) => setIsCompactViewport(width <= 760);
    updateCompactState(element.getBoundingClientRect().width);

    const observer = new ResizeObserver(([entry]) => {
      updateCompactState(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isCompactViewport) return;
    if (selectedId !== null) {
      document.querySelector<HTMLElement>('.backbone-detail .backbone-mobile-back')?.focus();
      return;
    }
    if (!restoreSelectionFocusRef.current) return;
    restoreSelectionFocusRef.current = false;
    const origin = selectionOriginRef.current;
    const currentRow = origin
      ? document.querySelector<HTMLElement>(`[data-backbone-id="${origin.id}"]`)
      : null;
    if (origin?.element?.isConnected) origin.element.focus();
    else if (currentRow) currentRow.focus();
    else workspaceHeadingRef.current?.focus();
  }, [isCompactViewport, selectedId]);

  useEffect(() => {
    if (!restoreMutationFocusRef.current || mapping !== null || unlinking !== null) return;
    restoreMutationFocusRef.current = false;
    const opener = mutationOpenerRef.current;
    queueMicrotask(() => {
      if (opener?.isConnected) return;
      document.querySelector<HTMLElement>(`#backbone-detail-${selectedId}`)?.focus();
    });
  }, [mapping, selectedId, unlinking]);

  function selectBackbone(id: number) {
    selectionOriginRef.current = {
      id,
      element: document.querySelector<HTMLElement>(`[data-backbone-id="${id}"]`)
    };
    workspace.selectBackbone(id);
  }

  function backToBackboneList() {
    restoreSelectionFocusRef.current = true;
    workspace.selectBackbone(null);
  }

  function openCreate(seed: BackbonePrefill | null = null) {
    setCreatePrefill(seed);
    setEditingBackbone(null);
    setEditorAttempted(false);
    setEditorOpen(true);
  }

  // Um endereço que veio da Descoberta abre o formulário de criação já com o
  // IP e o MAC. O valor é copiado para estado local antes de avisar o pai:
  // avisá-lo primeiro limpava a prop antes de o diálogo chegar a lê-la.
  // Quem não pode gerir backbones não ganha aqui um atalho para o formulário —
  // a permissão é a mesma do botão "Registar".
  useEffect(() => {
    if (!prefill) return;
    if (canManage) openCreate(prefill);
    onPrefillHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  function openEdit() {
    if (!selected) return;
    setEditingBackbone(selected);
    setEditorAttempted(false);
    setEditorOpen(true);
  }

  function openMapping(mode: MappingMode, assignmentId: number | null = null) {
    if (!selected) return;
    if (mode === 'transfer') {
      mutationOpenerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    setMappingAttempted(false);
    if (mode === 'link') {
      workspace.setUnlinkedQuery('');
      workspace.setUnlinkedPage(1);
    } else {
      workspace.setAssignmentQuery('');
      workspace.setAssignmentPage(1);
      workspace.setDestinationQuery('');
      workspace.setDestinationPage(1);
    }
    setMapping({ mode, initialAssignmentId: assignmentId, currentBackbone: selected });
  }

  function openUnlink(assignment: BackboneAssignmentSummary) {
    mutationOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setUnlinkAttempted(false);
    setUnlinking(assignment);
  }

  async function saveBackbone(input: BackboneWriteInput): Promise<boolean> {
    setEditorAttempted(true);
    const result = editingBackbone
      ? await workspace.updateBackbone(editingBackbone.id, input)
      : await workspace.createBackbone(input);
    if (!result) return false;
    setEditorOpen(false);
    return true;
  }

  async function saveMapping(
    assignmentIds: number[],
    targetId: number,
    reason: string | null
  ): Promise<number[]> {
    setMappingAttempted(true);
    const result = mapping?.mode === 'transfer' && assignmentIds.length === 1
      ? await workspace.transferAssignment(assignmentIds[0], targetId, reason).then(
          (assignment) => ({
            failedAssignmentIds: assignment ? [] : [assignmentIds[0]]
          })
        )
      : await workspace.linkAssignments(assignmentIds, targetId, reason);
    if (result.failedAssignmentIds.length === 0) {
      if (mapping?.mode === 'transfer') restoreMutationFocusRef.current = true;
      setMapping(null);
    }
    return result.failedAssignmentIds;
  }

  async function confirmUnlink(reason: string | null): Promise<boolean> {
    if (!unlinking) return false;
    setUnlinkAttempted(true);
    const result = await workspace.unlinkAssignment(unlinking.id, reason);
    if (!result) return false;
    restoreMutationFocusRef.current = true;
    setUnlinking(null);
    return true;
  }

  const editorOperation = editingBackbone ? 'updateBackbone' : 'createBackbone';
  const editorError = editorAttempted && workspace.mutationState.failure?.operation === editorOperation
    ? workspace.mutationState.failure.message
    : null;
  const mappingMutation = mappingAttempted
    && (workspace.mutationState.failure?.operation === 'linkAssignments'
      || workspace.mutationState.failure?.operation === 'transferAssignment')
    ? workspace.mutationState
    : {
        ...workspace.mutationState,
        error: null,
        failure: null,
        conflict: null,
        conflicts: [],
        failedAssignmentIds: [],
        assignmentErrors: {},
        assignmentFailures: {}
      };
  const unlinkError = unlinkAttempted && workspace.mutationState.failure?.operation === 'unlinkAssignment'
    ? workspace.mutationState.failure.message
    : null;

  return (
    <section
      ref={workspaceRef}
      className="backbone-workspace"
      data-detail-open={selectedId !== null || undefined}
      aria-label="Gestão de backbone"
    >
      <header className="backbone-workspace-header">
        <div>
          <p className="backbone-kicker">Infraestrutura física</p>
          <h2 ref={workspaceHeadingRef} tabIndex={-1}>Backbone</h2>
          <p>Identidade, implantação e ligações verificáveis do inventário.</p>
        </div>
        {canManage && (
          <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={() => openCreate()}>
            Novo backbone
          </Button>
        )}
      </header>

      {workspace.error && workspace.backbones.items.length > 0 && (
        <div className="backbone-inline-error" role="alert">
          <RadioTower size={15} aria-hidden />
          <span>{workspace.error}</span>
          <Button variant="ghost" size="sm" onClick={() => void workspace.refresh()}>Tentar novamente</Button>
        </div>
      )}

      <div className="backbone-master-detail">
        <BackboneList
          page={workspace.backbones}
          selectedId={selectedId}
          query={workspace.backboneQuery}
          status={workspace.backboneStatusFilter}
          loading={workspace.backboneLoading}
          error={workspace.backboneError}
          unlinkedCount={workspace.unlinked.total}
          onQueryChange={(query) => {
            workspace.setBackbonePage(1);
            workspace.setBackboneQuery(query);
          }}
          onStatusChange={(status) => {
            workspace.setBackbonePage(1);
            workspace.setBackboneStatusFilter(status);
          }}
          onPageChange={workspace.setBackbonePage}
          onSelect={selectBackbone}
          onRetry={() => void workspace.refresh()}
        />
        <BackboneDetail
          backbone={selected}
          linked={workspace.linked}
          linkedQuery={workspace.linkedQuery}
          linkedLoading={workspace.linkedLoading}
          linkedError={workspace.linkedError}
          selectedId={selectedId}
          canManage={canManage}
          loading={workspace.loading}
          onBack={backToBackboneList}
          onEdit={openEdit}
          onLink={() => openMapping('link')}
          onTransfer={(assignment) => openMapping('transfer', assignment.id)}
          onUnlink={openUnlink}
          onViewTopology={onViewTopology}
          onSelectDownstream={selectBackbone}
          onLinkedQueryChange={(query) => {
            workspace.setLinkedPage(1);
            workspace.setLinkedQuery(query);
          }}
          onLinkedPageChange={workspace.setLinkedPage}
          onLinkedRetry={() => void workspace.refreshLinked()}
        />
      </div>

      {canManage && (
        <>
          <BackboneEditorDialog
            open={editorOpen}
            backbone={editingBackbone}
            prefill={createPrefill}
            pending={workspace.mutationState.pending}
            error={editorError}
            catalogs={workspace.catalogs}
            catalogLoading={workspace.catalogLoading}
            catalogError={workspace.catalogError}
            upstreamOptions={workspace.destinations.items}
            onCatalogRetry={() => void workspace.refreshCatalogs()}
            onClose={() => { setEditorOpen(false); setCreatePrefill(null); }}
            onSubmit={saveBackbone}
          />
          <BackboneMappingDialog
            open={mapping !== null}
            mode={mapping?.mode ?? 'link'}
            currentBackbone={mapping?.currentBackbone ?? selected}
            candidates={mapping?.mode === 'transfer' ? workspace.assignments : workspace.unlinked}
            destinations={workspace.destinations}
            destinationQuery={workspace.destinationQuery}
            destinationLoading={workspace.destinationLoading}
            destinationError={workspace.destinationError}
            initialAssignmentId={mapping?.initialAssignmentId ?? null}
            query={mapping?.mode === 'transfer' ? workspace.assignmentQuery : workspace.unlinkedQuery}
            candidateLoading={mapping?.mode === 'transfer'
              ? workspace.assignmentLoading
              : workspace.unlinkedLoading}
            candidateError={mapping?.mode === 'transfer'
              ? workspace.assignmentError
              : workspace.unlinkedError}
            pending={workspace.mutationState.pending}
            mutationState={mappingMutation}
            onQueryChange={(query) => {
              if (mapping?.mode === 'transfer') {
                workspace.setAssignmentPage(1);
                workspace.setAssignmentQuery(query);
              } else {
                workspace.setUnlinkedPage(1);
                workspace.setUnlinkedQuery(query);
              }
            }}
            onPageChange={mapping?.mode === 'transfer'
              ? workspace.setAssignmentPage
              : workspace.setUnlinkedPage}
            onCandidateRetry={() => void workspace.refresh()}
            onDestinationQueryChange={(query) => {
              workspace.setDestinationPage(1);
              workspace.setDestinationQuery(query);
            }}
            onDestinationPageChange={workspace.setDestinationPage}
            onDestinationRetry={() => void workspace.refreshDestinations()}
            onClose={() => setMapping(null)}
            onSubmit={saveMapping}
          />
          <BackboneUnlinkDialog
            open={unlinking !== null}
            assignment={unlinking}
            pending={workspace.mutationState.pending}
            error={unlinkError}
            onClose={() => setUnlinking(null)}
            onConfirm={confirmUnlink}
          />
        </>
      )}
    </section>
  );
}
