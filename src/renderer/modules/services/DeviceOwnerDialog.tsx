import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Button, Dialog, Message, Select, Textarea, Toggle } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';
import type { DeviceAssignment } from '../../types';

const API = 'http://127.0.0.1:3001';

export type PromoteOwnerResult = {
  assignmentId: number;
  fromServiceId: number;
  toServiceId: number;
  fromClientName: string;
  toClientName: string;
  keptPreviousAsShare: boolean;
  rentalFeeCve: number;
};

type DeviceOwnerDialogProps = {
  assignment: DeviceAssignment;
  /** Serviço aberto: é ele que assume a antena quando o diálogo abre do lado partilhado. */
  currentServiceId: number;
  currentClientName: string;
  onClose: () => void;
  onDone: (result: PromoteOwnerResult) => void;
};

/**
 * Passar a titularidade de uma antena partilhada.
 *
 * O titular é a âncora do que é físico — stock, IP, devolução e renda — por isso
 * quando ele sai a antena tem de mudar de dono em vez de ficar órfã. Abre-se dos
 * dois lados: do titular escolhe-se qual dos vizinhos assume; do vizinho, é o
 * serviço aberto que assume.
 */
export function DeviceOwnerDialog({
  assignment,
  currentServiceId,
  currentClientName,
  onClose,
  onDone
}: DeviceOwnerDialogProps) {
  const fromOwner = Boolean(assignment.isOwner);
  const [targetId, setTargetId] = useState<number>(
    fromOwner ? (assignment.sharedWith[0]?.serviceId ?? 0) : currentServiceId
  );
  const [keepPrevious, setKeepPrevious] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = assignment.brand ? `${assignment.brand} ${assignment.model}` : assignment.model;
  const previousName = fromOwner ? currentClientName : (assignment.ownerClientName ?? 'titular atual');
  const targetName = fromOwner
    ? (assignment.sharedWith.find((row) => row.serviceId === targetId)?.clientName ?? '')
    : currentClientName;
  const rentalCve = assignment.ownership === 'isp' ? assignment.rentalFeeCve : 0;

  async function submit() {
    if (!targetId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authFetch(`${API}/api/service-device-assignments/${assignment.id}/owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId: targetId,
          keepPreviousAsShare: keepPrevious,
          reason: reason.trim() || null
        })
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || 'Nao foi possivel passar a titularidade.');
        return;
      }
      onDone(result as PromoteOwnerResult);
    } catch {
      setError('Nao foi possivel passar a titularidade.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      size="md"
      eyebrow="Equipamento"
      title="Passar titularidade"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button
            leadingIcon={<ArrowRightLeft size={16} aria-hidden />}
            disabled={submitting || !targetId}
            onClick={() => void submit()}
          >
            {submitting ? 'A passar...' : 'Passar titularidade'}
          </Button>
        </>
      }
    >
      <div className="service-transfer">
        <p className="service-transfer-lead">
          A antena <strong>{label}</strong> continua onde esta: nao ha baixa de stock nem
          reinstalacao. Muda quem responde pela unidade — e quem paga o aluguer.
        </p>
        {error && <Message tone="error">{error}</Message>}

        {fromOwner ? (
          assignment.sharedWith.length > 0 ? (
            <Select
              label="Novo titular"
              hint="So os servicos que ja sao servidos por esta antena podem assumi-la."
              value={String(targetId)}
              onChange={(event) => setTargetId(Number(event.target.value))}
            >
              {assignment.sharedWith.map((row) => (
                <option key={row.serviceId} value={row.serviceId}>
                  {row.clientName} (servico #{row.serviceId})
                </option>
              ))}
            </Select>
          ) : (
            <Message tone="error">Esta antena nao serve mais nenhum servico.</Message>
          )
        ) : (
          <Message>
            {currentClientName} passa a ser o titular da antena, hoje de {previousName}.
          </Message>
        )}

        <Toggle
          title="O titular antigo continua a ser servido por esta antena"
          description="Ligue quando a antena continua a alimentar o titular antigo; deixe desligado quando ele esta a sair."
          checked={keepPrevious}
          onChange={(event) => setKeepPrevious(event.target.checked)}
        />

        <Textarea
          label="Motivo"
          rows={2}
          value={reason}
          placeholder="Ex.: titular cancelou, antena fica no predio"
          onChange={(event) => setReason(event.target.value)}
        />

        {targetName && (
          <div className="service-transfer-summary">
            <p>
              <strong>{previousName}</strong>{' → '}<strong>{targetName}</strong>
            </p>
            <ul>
              <li>
                {rentalCve > 0
                  ? `A renda de ${formatCve(rentalCve)}/mes passa a ser cobrada a ${targetName}.`
                  : 'Sem renda associada a esta unidade.'}
              </li>
              {assignment.ipAddress && <li>O IP {assignment.ipAddress} passa a pertencer a {targetName}.</li>}
              <li>
                {keepPrevious
                  ? `${previousName} continua servido, agora por partilha.`
                  : `${previousName} deixa de ser servido por esta antena.`}
              </li>
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
