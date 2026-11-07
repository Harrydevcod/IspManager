import { useState } from 'react';
import { Button, Dialog, Field, Message, Select } from '../../components';
import { businessDay } from '../../../shared/business-day';
import type { ServiceRow } from '../../types';

export type SuspendRequest = {
  source: 'client_request' | 'manual';
  pauseUntil: string | null;
};

type Props = {
  service: ServiceRow;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (request: SuspendRequest) => void;
};

/** Dia seguinte a `iso` (YYYY-MM-DD), para o `min` do campo de data. */
function nextDay(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Suspender tem dois motivos com consequências diferentes.
 *
 * Uma ausência a pedido do cliente (férias, viagem) é uma pausa: fatura só o
 * aluguer, um pagamento não a desfaz, e com data de regresso o serviço volta
 * sozinho nesse dia. A suspensão pelo operador fica como sempre foi.
 *
 * Num serviço já em pausa o mesmo diálogo muda o regresso.
 */
export function SuspendServiceDialog({ service, submitting, error, onClose, onConfirm }: Props) {
  const paused = service.status === 'suspended' && service.suspensionSource === 'client_request';
  const [source, setSource] = useState<SuspendRequest['source']>('client_request');
  const [pauseUntil, setPauseUntil] = useState(paused ? service.pauseUntil ?? '' : '');
  const minDate = nextDay(businessDay());
  const dateInvalid = source === 'client_request' && pauseUntil !== '' && pauseUntil < minDate;

  function confirm() {
    if (dateInvalid) return;
    onConfirm({ source, pauseUntil: source === 'client_request' && pauseUntil ? pauseUntil : null });
  }

  return (
    <Dialog
      open
      eyebrow={service.clientName}
      title={paused ? 'Alterar regresso' : 'Suspender serviço'}
      onClose={onClose}
      closeOnBackdrop={!submitting}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button variant={source === 'manual' ? 'danger' : 'primary'} onClick={confirm} loading={submitting}>
            {paused ? 'Guardar regresso' : source === 'client_request' ? 'Pôr em pausa' : 'Suspender'}
          </Button>
        </>
      )}
    >
      <div className="suspend-service">
        {!paused && (
          <Select label="Motivo" value={source} onChange={(event) => setSource(event.target.value as SuspendRequest['source'])}>
            <option value="client_request">Ausência a pedido do cliente</option>
            <option value="manual">Suspensão pelo operador</option>
          </Select>
        )}

        {source === 'client_request' ? (
          <>
            <p className="suspend-service-lead">
              Enquanto estiver em pausa, a mensalidade sai <strong>só com o aluguer dos equipamentos</strong>.
              O PPPoE é desativado no MikroTik, e pagar não reativa o serviço.
            </p>
            <Field
              label="Regressa a"
              type="date"
              min={minDate}
              value={pauseUntil}
              onChange={(event) => setPauseUntil(event.target.value)}
              error={dateInvalid ? 'A data de regresso tem de ser posterior a hoje' : undefined}
              hint={pauseUntil ? 'Nesse dia o serviço volta a ativo sozinho' : 'Sem data, a pausa só acaba quando reativar à mão'}
            />
          </>
        ) : (
          <p className="suspend-service-lead">
            O serviço fica suspenso no ISPM e a reconciliação desativa o PPPoE no MikroTik.
          </p>
        )}

        {error ? <Message tone="error">{error}</Message> : null}
      </div>
    </Dialog>
  );
}
