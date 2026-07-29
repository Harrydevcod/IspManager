import { AlertTriangle, ChevronLeft, ChevronRight, Link2, Search, Unlink } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneDeviceSummary,
  BackbonePage,
  BackboneStatus,
  BackboneWriteInput
} from '../../../shared/backbone';
import type { BackboneMutationState } from './useBackboneWorkspace';
import { Badge, Button, Dialog, Field, Select, Textarea, Toggle } from '../../components';

type EditorProps = {
  open: boolean;
  backbone: BackboneDeviceDetail | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: BackboneWriteInput) => Promise<boolean>;
};

type EditorState = {
  catalogId: string;
  name: string;
  status: BackboneStatus;
  serialNumber: string;
  assetTag: string;
  ipAddress: string;
  macAddress: string;
  island: string;
  zone: string;
  notes: string;
};

function editorState(backbone: BackboneDeviceDetail | null): EditorState {
  return {
    catalogId: backbone ? String(backbone.catalogId) : '',
    name: backbone?.name ?? '',
    status: backbone?.status ?? 'active',
    serialNumber: backbone?.serialNumber ?? '',
    assetTag: backbone?.assetTag ?? '',
    ipAddress: backbone?.ipAddress ?? '',
    macAddress: backbone?.macAddress ?? '',
    island: backbone?.island ?? '',
    zone: backbone?.zone ?? '',
    notes: backbone?.notes ?? ''
  };
}

function nullable(value: string): string | null {
  return value.trim() || null;
}

export function BackboneEditorDialog({
  open,
  backbone,
  pending,
  error,
  onClose,
  onSubmit
}: EditorProps) {
  const [form, setForm] = useState<EditorState>(() => editorState(backbone));
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(editorState(backbone));
    setValidation(null);
  }, [backbone, open]);

  function update<K extends keyof EditorState>(key: K, value: EditorState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const catalogId = Number(form.catalogId);
    if (!Number.isInteger(catalogId) || catalogId <= 0) {
      setValidation('Indique um catálogo válido.');
      return;
    }
    if (!form.name.trim()) {
      setValidation('Indique o nome operacional.');
      return;
    }
    setValidation(null);
    await onSubmit({
      catalogId,
      name: form.name.trim(),
      status: form.status,
      serialNumber: nullable(form.serialNumber),
      assetTag: nullable(form.assetTag),
      ipAddress: nullable(form.ipAddress),
      macAddress: nullable(form.macAddress),
      island: nullable(form.island),
      zone: nullable(form.zone),
      notes: nullable(form.notes),
      ...(backbone ? { expectedUpdatedAt: backbone.updatedAt } : {})
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow={backbone ? 'Inventário físico' : 'Nova unidade física'}
      title={backbone ? `Editar ${backbone.name}` : 'Novo backbone'}
      size="lg"
      closeOnBackdrop={!pending}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancelar</Button>
          <Button type="submit" form="backbone-editor-form" loading={pending}>
            {backbone ? 'Guardar alterações' : 'Registar backbone'}
          </Button>
        </>
      )}
    >
      <form id="backbone-editor-form" className="backbone-editor-form" onSubmit={submit}>
        {(validation || error) && (
          <div className="backbone-dialog-error" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <span>{validation || error}</span>
          </div>
        )}
        <div className="backbone-dialog-section">
          <p>Registo</p>
          <Field
            label="ID do catálogo"
            type="number"
            min={1}
            required
            value={form.catalogId}
            onChange={(event) => update('catalogId', event.target.value)}
            hint="Equipamento correspondente no Stock."
          />
          <Field
            label="Nome operacional"
            required
            value={form.name}
            onChange={(event) => update('name', event.target.value)}
            placeholder="Ex.: Monte Verde Norte"
          />
          <Select
            label="Estado"
            value={form.status}
            onChange={(event) => update('status', event.target.value as BackboneStatus)}
          >
            <option value="active">Ativo</option>
            <option value="maintenance">Em manutenção</option>
            <option value="retired">Retirado</option>
          </Select>
        </div>
        <div className="backbone-dialog-section">
          <p>Identidade física</p>
          <Field
            label="Número de série"
            value={form.serialNumber}
            onChange={(event) => update('serialNumber', event.target.value)}
          />
          <Field
            label="Etiqueta patrimonial"
            value={form.assetTag}
            onChange={(event) => update('assetTag', event.target.value)}
          />
          <Field
            label="Endereço IP"
            value={form.ipAddress}
            onChange={(event) => update('ipAddress', event.target.value)}
          />
          <Field
            label="Endereço MAC"
            value={form.macAddress}
            onChange={(event) => update('macAddress', event.target.value)}
          />
          <small className="backbone-form-note">
            Sem série e etiqueta, a unidade será marcada como provisória.
          </small>
        </div>
        <div className="backbone-dialog-section">
          <p>Implantação</p>
          <Field label="Ilha" value={form.island} onChange={(event) => update('island', event.target.value)} />
          <Field label="Zona" value={form.zone} onChange={(event) => update('zone', event.target.value)} />
          <Textarea
            className="backbone-notes-field"
            label="Notas"
            value={form.notes}
            onChange={(event) => update('notes', event.target.value)}
            rows={3}
          />
        </div>
      </form>
    </Dialog>
  );
}

export type MappingMode = 'link' | 'transfer';

type MappingDialogProps = {
  open: boolean;
  mode: MappingMode;
  currentBackbone: BackboneDeviceDetail | null;
  candidates: BackbonePage<BackboneAssignmentSummary>;
  backbones: BackboneDeviceSummary[];
  initialAssignmentId: number | null;
  query: string;
  pending: boolean;
  mutationState: BackboneMutationState;
  onQueryChange: (value: string) => void;
  onPageChange: (page: number) => void;
  onClose: () => void;
  onSubmit: (assignmentIds: number[], targetId: number, reason: string | null) => Promise<number[]>;
};

function assignmentLabel(assignment: BackboneAssignmentSummary): string {
  return [assignment.catalogBrand, assignment.catalogModel].filter(Boolean).join(' ');
}

export function BackboneMappingDialog({
  open,
  mode,
  currentBackbone,
  candidates,
  backbones,
  initialAssignmentId,
  query,
  pending,
  mutationState,
  onQueryChange,
  onPageChange,
  onClose,
  onSubmit
}: MappingDialogProps) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const visibleCandidates = useMemo(
    () => candidates.items.filter((assignment) => assignment.serviceStatus !== 'cancelled'),
    [candidates.items]
  );

  useEffect(() => {
    if (!open) return;
    setSelectedIds(initialAssignmentId ? [initialAssignmentId] : []);
    setTargetId(mode === 'link' && currentBackbone ? String(currentBackbone.id) : '');
    setReason('');
    setValidation(null);
  }, [currentBackbone, initialAssignmentId, mode, open]);

  function toggle(id: number) {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsedTarget = Number(targetId);
    if (selectedIds.length === 0) {
      setValidation('Selecione pelo menos um equipamento.');
      return;
    }
    if (!Number.isInteger(parsedTarget) || parsedTarget <= 0) {
      setValidation('Selecione o backbone de destino.');
      return;
    }
    setValidation(null);
    const failedIds = await onSubmit(selectedIds, parsedTarget, nullable(reason));
    if (failedIds.length > 0) setSelectedIds(failedIds);
  }

  const title = mode === 'link'
    ? `Ligar a ${currentBackbone?.name ?? 'backbone'}`
    : 'Transferir equipamentos';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow={mode === 'link' ? 'Sem ligação definida' : 'Mudança de backbone'}
      title={title}
      size="xl"
      closeOnBackdrop={!pending}
      actions={(
        <>
          <span className="backbone-dialog-selection" aria-live="polite">
            {selectedIds.length} selecionado{selectedIds.length === 1 ? '' : 's'}
          </span>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancelar</Button>
          <Button
            type="submit"
            form="backbone-mapping-form"
            loading={pending}
            leadingIcon={<Link2 size={15} aria-hidden />}
          >
            {mode === 'link' ? 'Criar ligações' : 'Transferir'}
          </Button>
        </>
      )}
    >
      <form id="backbone-mapping-form" className="backbone-mapping-form" onSubmit={submit}>
        {(validation || mutationState.error || mutationState.failedAssignmentIds.length > 0) && (
          <div className="backbone-dialog-error" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <div>
              <strong>{validation || mutationState.error || 'Algumas ligações não foram alteradas.'}</strong>
              {mutationState.failedAssignmentIds.map((id) => (
                <span key={id}>Equipamento #{id}: {mutationState.assignmentErrors[id]}</span>
              ))}
            </div>
          </div>
        )}

        {mode === 'transfer' && (
          <Select label="Backbone de destino" required value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <option value="">Selecionar destino…</option>
            {backbones
              .filter((item) => item.status === 'active' && item.id !== currentBackbone?.id)
              .map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </Select>
        )}

        <div className="backbone-dialog-search">
          <Search size={15} aria-hidden />
          <Field
            hideLabel
            label="Pesquisar equipamentos"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Cliente, código, série, IP ou MAC…"
          />
        </div>

        <div className="backbone-candidate-list" aria-label="Equipamentos disponíveis">
          {visibleCandidates.length === 0 ? (
            <p className="backbone-candidate-empty">
              {query ? 'Nenhum equipamento corresponde à pesquisa.' : 'Não há equipamentos disponíveis.'}
            </p>
          ) : visibleCandidates.map((assignment) => {
            const selected = selectedIds.includes(assignment.id);
            const itemError = mutationState.assignmentErrors[assignment.id];
            return (
              <div
                className="backbone-candidate"
                data-selected={selected || undefined}
                data-error={!!itemError || undefined}
                key={assignment.id}
              >
                <Toggle
                  wide={false}
                  className="backbone-candidate-toggle"
                  title={`${assignment.clientName} · ${assignment.clientCode}`}
                  description={`${assignmentLabel(assignment)} · ${
                    assignment.serialNumber || assignment.assetTag || 'Identidade não informada'
                  }`}
                  checked={selected}
                  onChange={() => toggle(assignment.id)}
                  aria-describedby={itemError ? `assignment-${assignment.id}-error` : undefined}
                />
                {assignment.backboneName
                  ? <Badge tone="neutral">{assignment.backboneName}</Badge>
                  : <Badge tone="accent">Sem ligação</Badge>}
                {itemError && <small id={`assignment-${assignment.id}-error`} className="backbone-candidate-error">{itemError}</small>}
              </div>
            );
          })}
        </div>

        <div className="backbone-candidate-footer">
          <span>Página {candidates.page} de {Math.max(candidates.totalPages, 1)} · {candidates.total} equipamentos</span>
          <div>
            <Button
              variant="icon"
              size="sm"
              aria-label="Página anterior de equipamentos"
              disabled={candidates.page <= 1 || pending}
              onClick={() => onPageChange(candidates.page - 1)}
            >
              <ChevronLeft size={15} aria-hidden />
            </Button>
            <Button
              variant="icon"
              size="sm"
              aria-label="Página seguinte de equipamentos"
              disabled={candidates.page >= candidates.totalPages || pending}
              onClick={() => onPageChange(candidates.page + 1)}
            >
              <ChevronRight size={15} aria-hidden />
            </Button>
          </div>
        </div>

        <Field
          label="Motivo"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={mode === 'link' ? 'Ex.: instalação inicial' : 'Ex.: mudança de POP'}
          hint="Opcional. Fica associado ao registo de auditoria."
        />
      </form>
    </Dialog>
  );
}

type UnlinkDialogProps = {
  open: boolean;
  assignment: BackboneAssignmentSummary | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string | null) => Promise<boolean>;
};

export function BackboneUnlinkDialog({
  open,
  assignment,
  pending,
  error,
  onClose,
  onConfirm
}: UnlinkDialogProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onConfirm(nullable(reason));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Confirmar alteração"
      title="Desligar equipamento"
      size="sm"
      closeOnBackdrop={!pending}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancelar</Button>
          <Button
            variant="danger"
            type="submit"
            form="backbone-unlink-form"
            loading={pending}
            leadingIcon={<Unlink size={15} aria-hidden />}
          >
            Desligar
          </Button>
        </>
      )}
    >
      <form id="backbone-unlink-form" className="backbone-unlink-form" onSubmit={submit}>
        <p>
          A ligação de <strong>{assignment?.clientName}</strong> a este backbone será removida.
          O equipamento e o histórico permanecem registados.
        </p>
        {error && <div className="backbone-dialog-error" role="alert"><AlertTriangle size={16} aria-hidden />{error}</div>}
        <Field
          label="Motivo"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Ex.: equipamento removido"
        />
      </form>
    </Dialog>
  );
}
