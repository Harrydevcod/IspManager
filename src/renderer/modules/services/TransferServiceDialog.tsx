import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Button, Combobox, Dialog, Message, Select, Textarea, Toggle } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve } from '../../lib/format';
import { statusLabel } from '../../lib/status';
import type { Client, ServiceRow } from '../../types';

const API = 'http://127.0.0.1:3001';

export type TransferMode = 'manter' | 'reinstalar';

export type TransferResult = {
  serviceId: number;
  mode: TransferMode;
  fromClient: { id: number; name: string };
  toClient: { id: number; name: string };
  clientReactivated: boolean;
  previousStatus: ServiceRow['status'];
  status: ServiceRow['status'];
  freedIps: string[];
  pppoeRegenerated: boolean;
  warnings: string[];
};

type TransferServiceDialogProps = {
  /** Aberto a partir do serviço: a origem já está escolhida. */
  service?: ServiceRow | null;
  /** Aberto a partir da ficha do cliente: o destino já está escolhido. */
  toClient?: Client | null;
  onClose: () => void;
  onDone: (result: TransferResult) => void;
};

const MODE_HINT: Record<TransferMode, string> = {
  manter: 'Mesmo equipamento, mesmo IP, mesma antena. Muda so o titular.',
  reinstalar: 'O equipamento e recolhido e segue para o novo local: liberta o IP, fecha a ligacao a antena antiga e gera novas credenciais PPPoE.'
};

/**
 * Transferir o titular de um serviço — a casa muda de inquilino, ou o
 * equipamento é recolhido e reinstalado noutro cliente. Vive nos dois lados:
 * abre-se a partir do serviço (escolhe-se o cliente) ou a partir do cliente
 * (escolhe-se o serviço). O histórico de faturação não se move: as faturas já
 * emitidas continuam com quem foi faturado.
 */
export function TransferServiceDialog({ service, toClient, onClose, onDone }: TransferServiceDialogProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [serviceId, setServiceId] = useState<number | null>(service?.id ?? null);
  const [clientId, setClientId] = useState<number | null>(toClient?.id ?? null);
  const [mode, setMode] = useState<TransferMode>('manter');
  const [reactivate, setReactivate] = useState(true);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!toClient) {
      authFetch(`${API}/api/clients`)
        .then((response) => response.json() as Promise<Client[]>)
        .then(setClients)
        .catch(() => setError('Nao foi possivel carregar os clientes.'));
    }
    if (!service) {
      authFetch(`${API}/api/services`)
        .then((response) => response.json() as Promise<ServiceRow[]>)
        .then(setServices)
        .catch(() => setError('Nao foi possivel carregar os servicos.'));
    }
  }, [service, toClient]);

  const chosenService = service ?? services.find((row) => row.id === serviceId) ?? null;
  const chosenClient = toClient ?? clients.find((row) => row.id === clientId) ?? null;

  // Cancelados primeiro: é de lá que vem quase sempre o serviço a transferir.
  const serviceOptions = useMemo(() => {
    const rows = services.filter((row) => row.clientId !== (toClient?.id ?? -1));
    return [...rows].sort((a, b) => {
      const weight = (row: ServiceRow) => (row.status === 'cancelled' ? 0 : 1);
      return weight(a) - weight(b) || a.clientName.localeCompare(b.clientName);
    });
  }, [services, toClient]);

  const clientOptions = useMemo(
    () => clients.filter((row) => row.id !== (chosenService?.clientId ?? -1)),
    [clients, chosenService]
  );

  const monthlyCve = chosenService
    ? chosenService.monthlyValueCve
      + (chosenService.audiovisualMode === 'monthly' ? chosenService.audiovisualMonthlyCve : 0)
    : 0;

  async function submit() {
    if (!chosenService || !chosenClient) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authFetch(`${API}/api/services/${chosenService.id}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toClientId: chosenClient.id,
          mode,
          reactivateService: reactivate,
          reason: reason.trim() || null
        })
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || 'Nao foi possivel transferir o servico.');
        return;
      }
      onDone(result as TransferResult);
    } catch {
      setError('Nao foi possivel transferir o servico.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      size="md"
      eyebrow="Servico"
      title="Transferir titular"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button
            leadingIcon={<ArrowRightLeft size={16} aria-hidden />}
            disabled={submitting || !chosenService || !chosenClient}
            onClick={() => void submit()}
          >
            {submitting ? 'A transferir...' : 'Transferir'}
          </Button>
        </>
      }
    >
      <div className="service-transfer">
        <p className="service-transfer-lead">
          O servico muda de dono a partir de hoje. As faturas ja emitidas ficam com quem foi
          faturado — a transferencia nao reescreve contas correntes.
        </p>
        {error && <Message tone="error">{error}</Message>}

        {!service && (
          <label className="field">
            <span className="field-label">Servico a transferir</span>
            <Combobox
              ariaLabel="Servico a transferir"
              options={serviceOptions}
              value={serviceId}
              onChange={(next) => setServiceId(next == null ? null : Number(next))}
              rowKey={(row) => row.id}
              rowCode={(row) => `#${row.id}`}
              rowLabel={(row) => row.clientName}
              rowHint={(row) => `${row.planName || 'Sem plano'} - ${statusLabel(row.status)}`}
              placeholder="Selecionar servico..."
            />
          </label>
        )}

        {!toClient && (
          <label className="field">
            <span className="field-label">Novo titular</span>
            <Combobox
              ariaLabel="Novo titular"
              options={clientOptions}
              value={clientId}
              onChange={(next) => setClientId(next == null ? null : Number(next))}
              rowKey={(row) => row.id}
              rowCode={(row) => row.clientCode}
              rowLabel={(row) => row.fullName}
              rowHint={(row) => (row.status === 'cancelled' ? 'Cancelado - volta a ativo' : row.phone || undefined)}
              placeholder="Selecionar cliente..."
            />
          </label>
        )}

        <Select
          label="Instalacao"
          hint={MODE_HINT[mode]}
          value={mode}
          onChange={(event) => setMode(event.target.value as TransferMode)}
        >
          <option value="manter">Fica no mesmo local</option>
          <option value="reinstalar">Recolhido e reinstalado noutro local</option>
        </Select>

        <Toggle
          title="Reativar o servico"
          description="Deixe ligado para o novo titular ficar com o servico ativo."
          checked={reactivate}
          onChange={(event) => setReactivate(event.target.checked)}
        />

        <Textarea
          label="Motivo"
          rows={2}
          value={reason}
          placeholder="Ex.: mudanca de inquilino"
          onChange={(event) => setReason(event.target.value)}
        />

        {chosenService && chosenClient && (
          <div className="service-transfer-summary">
            <p>
              <strong>{chosenService.clientName}</strong>
              {' → '}
              <strong>{chosenClient.fullName}</strong>
            </p>
            <ul>
              <li>Mensalidade que transita: {formatCve(monthlyCve)} + aluguer do equipamento do ISP.</li>
              <li>Faturas ja emitidas ficam com {chosenService.clientName}.</li>
              {chosenClient.status === 'cancelled' && <li>{chosenClient.fullName} volta a cliente ativo.</li>}
              {reactivate && chosenService.status !== 'active' && (
                <li>Servico passa de {statusLabel(chosenService.status).toLowerCase()} a ativo.</li>
              )}
              {mode === 'reinstalar' && <li>O IP atual fica livre e a antena antiga deixa de o servir.</li>}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
