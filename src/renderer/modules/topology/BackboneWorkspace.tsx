import { Plus, RadioTower } from 'lucide-react';
import { useMemo, useState } from 'react';
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

export type BackboneWorkspaceProps = {
  onMutation: () => void;
  onViewTopology: (backboneDeviceId: number) => void;
};

type MappingState = {
  mode: MappingMode;
  initialAssignmentId: number | null;
  currentBackbone: BackboneDeviceDetail;
} | null;

export function BackboneWorkspace({ onMutation, onViewTopology }: BackboneWorkspaceProps) {
  const auth = useAuth();
  const canManage = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const api = useMemo(() => createBackboneApi(), []);
  const workspace = useBackboneWorkspace(api, onMutation);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingBackbone, setEditingBackbone] = useState<BackboneDeviceDetail | null>(null);
  const [mapping, setMapping] = useState<MappingState>(null);
  const [unlinking, setUnlinking] = useState<BackboneAssignmentSummary | null>(null);
  const [editorAttempted, setEditorAttempted] = useState(false);
  const [mappingAttempted, setMappingAttempted] = useState(false);
  const [unlinkAttempted, setUnlinkAttempted] = useState(false);

  const selected = workspace.selected;
  const selectedId = workspace.selectedId;

  function openCreate() {
    setEditingBackbone(null);
    setEditorAttempted(false);
    setEditorOpen(true);
  }

  function openEdit() {
    if (!selected) return;
    setEditingBackbone(selected);
    setEditorAttempted(false);
    setEditorOpen(true);
  }

  function openMapping(mode: MappingMode, assignmentId: number | null = null) {
    if (!selected) return;
    setMappingAttempted(false);
    if (mode === 'link') {
      workspace.setUnlinkedQuery('');
      workspace.setUnlinkedPage(1);
    } else {
      workspace.setAssignmentQuery('');
      workspace.setAssignmentPage(1);
    }
    setMapping({ mode, initialAssignmentId: assignmentId, currentBackbone: selected });
  }

  function openUnlink(assignment: BackboneAssignmentSummary) {
    setUnlinkAttempted(false);
    setUnlinking(assignment);
  }

  async function reloadSelectedDetail() {
    const id = workspace.selectedId;
    if (id === null) return;
    workspace.selectBackbone(null);
    // Cross a macrotask so React commits the deselection and the detail effect
    // invalidates its request before selecting the same ID again.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    workspace.selectBackbone(id);
  }

  async function saveBackbone(input: BackboneWriteInput): Promise<boolean> {
    setEditorAttempted(true);
    const result = editingBackbone
      ? await workspace.updateBackbone(editingBackbone.id, input)
      : await workspace.createBackbone(input);
    if (!result) {
      // The hook preserves the attempted payload and structured error. Revalidate
      // independently of render timing so a 409 never leaves list/detail stale.
      await workspace.refresh();
      await reloadSelectedDetail();
      return false;
    }
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
    await reloadSelectedDetail();
    if (result.failedAssignmentIds.length === 0) setMapping(null);
    return result.failedAssignmentIds;
  }

  async function confirmUnlink(reason: string | null): Promise<boolean> {
    if (!unlinking) return false;
    setUnlinkAttempted(true);
    const result = await workspace.unlinkAssignment(unlinking.id, reason);
    await reloadSelectedDetail();
    if (!result) return false;
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
      className="backbone-workspace"
      data-detail-open={selectedId !== null || undefined}
      aria-label="Gestão de backbone"
    >
      <header className="backbone-workspace-header">
        <div>
          <p className="backbone-kicker">Infraestrutura física</p>
          <h2>Backbone</h2>
          <p>Identidade, implantação e ligações verificáveis do inventário.</p>
        </div>
        {canManage && (
          <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={openCreate}>
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
          loading={workspace.loading}
          error={workspace.error}
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
          onSelect={workspace.selectBackbone}
          onRetry={() => void workspace.refresh()}
        />
        <BackboneDetail
          backbone={selected}
          selectedId={selectedId}
          canManage={canManage}
          loading={workspace.loading}
          onBack={() => workspace.selectBackbone(null)}
          onEdit={openEdit}
          onLink={() => openMapping('link')}
          onTransfer={(assignment) => openMapping('transfer', assignment.id)}
          onUnlink={openUnlink}
          onViewTopology={onViewTopology}
        />
      </div>

      {canManage && (
        <>
          <BackboneEditorDialog
            open={editorOpen}
            backbone={editingBackbone}
            pending={workspace.mutationState.pending}
            error={editorError}
            onClose={() => setEditorOpen(false)}
            onSubmit={saveBackbone}
          />
          <BackboneMappingDialog
            open={mapping !== null}
            mode={mapping?.mode ?? 'link'}
            currentBackbone={mapping?.currentBackbone ?? selected}
            candidates={mapping?.mode === 'transfer' ? workspace.assignments : workspace.unlinked}
            backbones={workspace.backbones.items}
            initialAssignmentId={mapping?.initialAssignmentId ?? null}
            query={mapping?.mode === 'transfer' ? workspace.assignmentQuery : workspace.unlinkedQuery}
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
