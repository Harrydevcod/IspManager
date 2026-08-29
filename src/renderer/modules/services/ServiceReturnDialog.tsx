import { useState } from 'react';
import { Badge, Button, Dialog, Field, Message, Select, Textarea, Toggle } from '../../components';
import { todayIso } from '../../../shared/assignment-dates';
import { formatCve } from '../../lib/format';
import type { DeviceAssignment, MaterialReturnLine, ReturnCondition } from '../../types';

type Props = {
  clientName: string;
  assignments: DeviceAssignment[];
  materialReturns: MaterialReturnLine[];
  /** Atribuição escolhida a partir da lista — entra pré-selecionada, sozinha. */
  focusAssignmentId?: number | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (payload: {
    devices: Array<{ assignmentId: number; condition: ReturnCondition }>;
    materials: Array<{ catalogId: number; quantity: number }>;
    notes: string | null;
    /** Dia da recolha: e uma visita, comum a tudo o que o tecnico trouxe. */
    returnedOn: string | null;
  }) => void;
};

const CONDITION_OPTIONS: Array<{ value: ReturnCondition; label: string; hint: string }> = [
  { value: 'bom', label: 'Bom estado', hint: 'volta ao stock' },
  { value: 'avariado', label: 'Avariado', hint: 'não volta ao stock' },
  { value: 'nao_devolvido', label: 'Não devolvido', hint: 'perda do cliente' }
];

const deviceLabel = (assignment: DeviceAssignment) =>
  assignment.brand ? `${assignment.brand} ${assignment.model}` : assignment.model;

/**
 * O momento do cancelamento: o técnico traz o material e regista o que voltou.
 *
 * Cada unidade escolhe o seu estado porque só uma que volte inteira pode ser
 * instalada noutro cliente — somar tudo ao stock por omissão era o que fazia o
 * armazém mentir. O material é parcial de propósito: recupera-se o cabo que der.
 */
export function ServiceReturnDialog({
  clientName,
  assignments,
  materialReturns,
  focusAssignmentId,
  submitting,
  error,
  onClose,
  onConfirm
}: Props) {
  const active = assignments.filter((assignment) => !assignment.endDate && assignment.isOwner);
  const ispDevices = active.filter((assignment) => assignment.ownership === 'isp');
  const clientDevices = active.filter((assignment) => assignment.ownership === 'cliente');
  const pendingMaterials = materialReturns.filter((material) => material.consumed - material.recovered > 0);

  const [selected, setSelected] = useState<Record<number, ReturnCondition | undefined>>(() => {
    const initial: Record<number, ReturnCondition> = {};
    for (const assignment of ispDevices) {
      // Focar uma unidade só quando o operador veio da linha dela.
      if (!focusAssignmentId || assignment.id === focusAssignmentId) {
        if (assignment.shareCount === 0) initial[assignment.id] = 'bom';
      }
    }
    return initial;
  });
  const [recovered, setRecovered] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [returnedOn, setReturnedOn] = useState(todayIso());

  const devices = Object.entries(selected)
    .filter(([, condition]) => Boolean(condition))
    .map(([id, condition]) => ({ assignmentId: Number(id), condition: condition as ReturnCondition }));

  const materials = pendingMaterials
    .map((material) => ({ catalogId: material.catalogId, quantity: Number(recovered[material.catalogId] || 0) }))
    .filter((material) => material.quantity > 0);

  const overRecovered = pendingMaterials.some((material) => {
    const value = Number(recovered[material.catalogId] || 0);
    return value > material.consumed - material.recovered;
  });

  const backToStock = devices.filter((device) => device.condition === 'bom').length;
  const lost = devices.length - backToStock;
  const rentalStopped = ispDevices
    .filter((assignment) => selected[assignment.id])
    .reduce((sum, assignment) => sum + assignment.rentalFeeCve, 0);
  const nothingToDo = devices.length === 0 && materials.length === 0;

  function toggle(assignment: DeviceAssignment) {
    setSelected((current) => ({
      ...current,
      [assignment.id]: current[assignment.id] ? undefined : 'bom'
    }));
  }

  return (
    <Dialog
      open
      size="lg"
      eyebrow="Devolução"
      title={`Devolução de equipamento — ${clientName}`}
      onClose={onClose}
      closeOnBackdrop={!submitting}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Fechar</Button>
          <Button
            onClick={() => onConfirm({ devices, materials, notes: notes.trim() || null, returnedOn: returnedOn || null })}
            loading={submitting}
            disabled={nothingToDo || overRecovered}
          >
            Registar devolução
          </Button>
        </>
      )}
    >
      <div className="service-return">
        <p className="service-return-lead">
          Marque o que voltou. Só o que estiver em <strong>bom estado</strong> regressa ao stock — o
          resto fica registado como perda. O aluguer pára em todos os casos, a partir da mensalidade
          seguinte.
        </p>

        <section className="service-return-section">
          <h4>Equipamento do ISP</h4>
          {ispDevices.length === 0 && (
            <Message>Não há equipamento do ISP por devolver neste serviço.</Message>
          )}
          {ispDevices.map((assignment) => {
            const shared = assignment.shareCount > 0;
            const condition = selected[assignment.id];
            return (
              <div key={assignment.id} className={shared ? 'service-return-row blocked' : 'service-return-row'}>
                <Toggle
                  wide={false}
                  title={deviceLabel(assignment)}
                  description={[
                    assignment.serialNumber,
                    assignment.rentalFeeCve > 0 ? `${formatCve(assignment.rentalFeeCve)}/mês` : null
                  ].filter(Boolean).join(' · ') || undefined}
                  checked={Boolean(condition)}
                  disabled={shared || submitting}
                  onChange={() => toggle(assignment)}
                />
                {shared ? (
                  <Badge tone="warn">Serve {assignment.shareCount + 1} serviços — desassocie primeiro</Badge>
                ) : (
                  <Select
                    aria-label={`Estado de ${deviceLabel(assignment)}`}
                    value={condition ?? 'bom'}
                    disabled={!condition || submitting}
                    onChange={(event) => setSelected((current) => ({
                      ...current,
                      [assignment.id]: event.target.value as ReturnCondition
                    }))}
                  >
                    {CONDITION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} — {option.hint}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            );
          })}
          {clientDevices.map((assignment) => (
            <div key={assignment.id} className="service-return-row muted-row">
              <span><strong>{deviceLabel(assignment)}</strong></span>
              <Badge tone="accent">Do cliente — fica com ele</Badge>
            </div>
          ))}
        </section>

        <section className="service-return-section">
          <h4>Material recuperado</h4>
          {pendingMaterials.length === 0 && (
            <Message>Sem material por recuperar neste serviço.</Message>
          )}
          {pendingMaterials.map((material) => {
            const pending = material.consumed - material.recovered;
            const value = Number(recovered[material.catalogId] || 0);
            return (
              <div key={material.catalogId} className="service-return-row">
                <span>
                  <strong>{material.brand ? `${material.brand} ${material.model}` : material.model}</strong>
                  <small className="muted">
                    {' '}· instalado {material.consumed} {material.unitOfMeasure}
                    {material.recovered > 0 ? ` · já recuperado ${material.recovered}` : ''}
                  </small>
                </span>
                <Field
                  label={`Quantidade recuperada de ${material.model}`}
                  hideLabel
                  wide={false}
                  className="service-return-qty"
                  type="number"
                  min={0}
                  max={pending}
                  step={1}
                  disabled={submitting}
                  value={recovered[material.catalogId] ?? ''}
                  placeholder={`0 de ${pending}`}
                  onChange={(event) => setRecovered((current) => ({
                    ...current,
                    [material.catalogId]: event.target.value
                  }))}
                />
                {value > pending ? <small className="service-return-error">Máximo {pending}</small> : null}
              </div>
            );
          })}
        </section>

        <Field
          label="Data da recolha"
          type="date"
          max={todayIso()}
          value={returnedOn}
          hint={returnedOn !== todayIso() ? 'Registo retroativo' : undefined}
          onChange={(event) => setReturnedOn(event.target.value)}
        />
        <Textarea
          label="Notas da devolução"
          rows={2}
          value={notes}
          disabled={submitting}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Ex.: antena partida na queda do poste"
        />

        <p className="service-return-summary">
          {backToStock} de volta ao stock · {lost} perda(s)
          {materials.length > 0 ? ` · ${materials.reduce((sum, m) => sum + m.quantity, 0)} un de material` : ''}
          {rentalStopped > 0 ? ` · ${formatCve(rentalStopped)}/mês de aluguer que pára` : ''}
        </p>

        {error ? <Message tone="error">{error}</Message> : null}
      </div>
    </Dialog>
  );
}
